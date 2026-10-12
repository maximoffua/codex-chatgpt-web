import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";

const MAX_STORED_RESPONSES = 1_000;
const RESPONSE_TTL_MS = 60 * 60 * 1_000;
const SNAPSHOT_DEBOUNCE_MS = 2_000;
/** In-memory high-water byte cap across all entries. Forced store:false continuation chains
 * store the full expanded input each turn — ~quadratic bytes per chain —
 * so a count cap alone cannot bound memory. Oldest-first eviction applies past this mark. */
const MAX_STORED_RESPONSE_BYTES = 64 * 1024 * 1024;
/** Entries whose serialized size exceeds this are kept in memory but skipped on disk: inputs can
 * carry base64 `input_image` data URLs, and one screenshot-heavy thread must not balloon the file. */
const SNAPSHOT_ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_TOTAL_MAX_BYTES = 24 * 1024 * 1024;

interface StoredResponseState {
  createdAt: number;
  items: unknown[];
  genericIdentity?: GenericResponseIdentity;
  modelId?: string;
  /** Approximate in-memory size, computed locally at insert time (never trusted from disk). */
  sizeBytes?: number;
}

/** Proxy-issued browser ownership for local OpenAI-compatible response chains. */
export interface GenericResponseIdentity {
  threadId: string;
  turnId: string;
}

function isGenericIdentity(value: unknown): value is GenericResponseIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.threadId === "string" && /^thread_generic_[a-f0-9]{32}$/.test(item.threadId)
    && typeof item.turnId === "string" && /^turn_generic_[a-f0-9]{32}$/.test(item.turnId);
}

const states = new Map<string, StoredResponseState>();
let storedResponseBytes = 0;

/** The ONLY size computation: approximate entry weight from its items payload. */
function measuredEntry(entry: Omit<StoredResponseState, "sizeBytes">): StoredResponseState {
  let sizeBytes = 0;
  try {
    sizeBytes = JSON.stringify(entry.items).length;
  } catch {
    /* unserializable items: weightless rather than fatal */
  }
  return { ...entry, sizeBytes };
}

/** The ONLY insertion point: keeps the byte counter consistent on replacement. */
function setEntry(id: string, entry: Omit<StoredResponseState, "sizeBytes">): void {
  deleteEntry(id);
  const measured = measuredEntry(entry);
  storedResponseBytes += measured.sizeBytes ?? 0;
  states.set(id, measured);
}

/** The ONLY deletion point: TTL, count, byte, and explicit deletes all route here. */
function deleteEntry(id: string): void {
  const existing = states.get(id);
  if (!existing) return;
  storedResponseBytes -= existing.sizeBytes ?? 0;
  if (storedResponseBytes < 0) storedResponseBytes = 0;
  states.delete(id);
}
// Expansion provenance must stay proxy-private: a WeakMap distinguishes replayed history from the
// newly appended input suffix without adding an unknown field that native passthrough could send
// upstream. Consumers use the prefix length to bind trusted history and rolling checkpoints to the
// exact replayed portion of this request.
const replayedInputPrefixLengths = new WeakMap<object, number>();
const replayedGenericIdentities = new WeakMap<object, GenericResponseIdentity>();
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersistPath: string | null = null;

function now(): number {
  return Date.now();
}

function snapshotPath(): string {
  return join(getConfigDir(), "responses-state.json");
}

/**
 * Best-effort disk snapshot so previous_response_id chains survive a proxy restart (the
 * dominant expansion-miss cause: an in-memory-only store dies with the process, and the next
 * chained turn then reaches the upstream as a naked delta). Load is lazy on first store access;
 * persistence is debounced + unref'd so the hot path never blocks and the process can exit.
 * Every disk failure is swallowed — the snapshot is a cache, not a source of truth.
 */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const path = snapshotPath();
    if (!existsSync(path)) return;
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown; states?: unknown };
    if (raw.version !== 1 || !Array.isArray(raw.states)) return;
    for (const entry of raw.states) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, state] = entry as [unknown, unknown];
      if (typeof id !== "string" || !state || typeof state !== "object") continue;
      const rec = state as StoredResponseState;
      if (typeof rec.createdAt !== "number" || !Array.isArray(rec.items)) continue;
      // Recompute sizes locally while loading; persisted sizeBytes is never trusted.
      setEntry(id, {
        createdAt: rec.createdAt,
        items: rec.items,
        ...(isGenericIdentity(rec.genericIdentity) ? { genericIdentity: rec.genericIdentity } : {}),
        ...(typeof rec.modelId === "string" ? { modelId: rec.modelId } : {}),
      });
    }
    pruneResponses();
  } catch {
    /* missing/corrupt snapshot: start empty */
  }
}

function persistNow(path: string): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  pendingPersistPath = null;
  try {
    const entries: [string, StoredResponseState][] = [];
    let total = 0;
    // Newest-first so the most recent chains survive both caps.
    for (const entry of [...states].reverse()) {
      // sizeBytes is in-memory accounting only; keep it out of the disk snapshot.
      const [id, state] = entry;
      const { sizeBytes: _sizeBytes, ...persistable } = state;
      const persistEntry: [string, StoredResponseState] = [id, persistable];
      const size = JSON.stringify(persistEntry).length;
      if (size > SNAPSHOT_ENTRY_MAX_BYTES) continue;
      if (total + size > SNAPSHOT_TOTAL_MAX_BYTES) break;
      total += size;
      entries.push(persistEntry);
    }
    entries.reverse();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // mkdirSync's mode only applies on creation — re-harden an existing config dir so the
    // conversation-content snapshot never lands in a group/world-readable directory.
    try { chmodSync(dirname(path), 0o700); } catch { /* best-effort (e.g. Windows) */ }
    atomicWriteFile(path, JSON.stringify({ version: 1, states: entries }));
  } catch {
    /* best-effort: disk trouble must never affect request handling */
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  // Resolve the target path now: tests may swap CODEX_CHATGPT_WEB_HOME before the
  // debounce fires, and a late write must land in the home that owned the recorded state.
  pendingPersistPath = snapshotPath();
  const path = pendingPersistPath;
  persistTimer = setTimeout(() => persistNow(path), SNAPSHOT_DEBOUNCE_MS);
  (persistTimer as { unref?: () => void }).unref?.();
}

/** Flush any pending debounced snapshot write (graceful shutdown / deterministic tests). */
export function flushResponseState(): void {
  if (!persistTimer) return;
  // Use the path captured when the write was scheduled; CODEX_CHATGPT_WEB_HOME may have moved.
  persistNow(pendingPersistPath ?? snapshotPath());
}

function inputItems(input: unknown): unknown[] {
  if (input === undefined) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === "string") return [{ role: "user", content: input }];
  return [input];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function userContent(value: unknown): string | undefined {
  const content = object(value)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.map(part => {
    const item = object(part);
    return typeof item?.text === "string" ? item.text : JSON.stringify(item ?? part);
  }).join("\n");
}

interface OutstandingCall {
  type: string;
  name: string;
  /** Bridge item id (`fc_…`); stateless clients that rewrite `call_id` still echo it back. */
  id?: string;
}

function outstandingCalls(items: unknown[]): Map<string, OutstandingCall> {
  const pending = new Map<string, OutstandingCall>();
  for (const value of items) {
    const item = object(value);
    if ((item?.type === "function_call" || item?.type === "custom_tool_call")
      && typeof item.call_id === "string" && typeof item.name === "string") {
      pending.set(item.call_id, {
        type: item.type,
        name: item.name,
        ...(typeof item.id === "string" && item.id ? { id: item.id } : {}),
      });
    } else if ((item?.type === "function_call_output" || item?.type === "custom_tool_call_output")
      && typeof item.call_id === "string") {
      pending.delete(item.call_id);
    }
  }
  return pending;
}

/**
 * Pi and other stateless Responses clients resend their complete transcript, without
 * previous_response_id, after a function call. Match that exact outstanding call and
 * the original user instruction to a proxy-owned browser turn. This keeps the live
 * broker waiting for the result instead of abandoning it and opening a new browser.
 * An ambiguous match is intentionally treated as a new independent request.
 */
export function expandStatelessGenericToolOutputs(body: unknown): unknown {
  const request = object(body);
  if (!request || request.previous_response_id !== undefined || !Array.isArray(request.input)
    || typeof request.model !== "string") return body;
  const input = request.input;
  let resultStart = input.length;
  while (resultStart > 0) {
    const type = object(input[resultStart - 1])?.type;
    if (type !== "function_call_output" && type !== "custom_tool_call_output") break;
    resultStart--;
  }
  if (resultStart === input.length || resultStart === 0) return body;
  const results = input.slice(resultStart);
  const resultIds = results.map(item => object(item)?.call_id);
  if (resultIds.some(id => typeof id !== "string" || !id)
    || new Set(resultIds).size !== resultIds.length) return body;
  const before = input.slice(0, resultStart);
  const lastUser = before.findLastIndex(item => object(item)?.role === "user");
  if (lastUser < 0) return body;
  const clientUserText = userContent(before[lastUser]);
  if (clientUserText === undefined) return body;
  ensureLoaded();
  pruneResponses();
  let matched: StoredResponseState | undefined;
  for (const state of [...states.values()].reverse()) {
    const identity = state.genericIdentity;
    if (!identity || state.modelId !== request.model) continue;
    const pending = outstandingCalls(state.items);
    if (pending.size !== results.length) continue;
    // Clients such as Pi rewrite `call_id` to their own internal id on replay while preserving
    // the bridge item id (`fc_…`). Link each result through the client's re-sent call item so
    // those transcripts keep the waiting browser turn instead of opening a new one.
    const pendingByItemId = new Map<string, OutstandingCall>();
    for (const entry of pending.values()) {
      if (entry.id !== undefined && !pendingByItemId.has(entry.id)) pendingByItemId.set(entry.id, entry);
    }
    const clientCallsMatch = results.every(item => {
      const result = object(item)!;
      const waiting = pending.get(result.call_id as string);
      let expected: OutstandingCall | undefined = waiting;
      let clientCallId = result.call_id as string;
      if (!expected) {
        const clientCall = before.findLastIndex(value => {
          const call = object(value);
          return (call?.type === "function_call" || call?.type === "custom_tool_call")
            && call.call_id === (result.call_id as string);
        });
        if (clientCall < 0) return false;
        const call = object(before[clientCall])!;
        expected = typeof call.id === "string"
          ? pendingByItemId.get(call.id)
          : undefined;
        if (!expected || expected.name !== call.name) return false;
      }
      if (result.type !== `${expected.type}_output`) return false;
      if (expected.id !== undefined) pendingByItemId.delete(expected.id);
      const callIndex = before.findLastIndex(value => {
        const call = object(value);
        return call?.type === expected!.type && call.call_id === clientCallId
          && call.name === expected!.name;
      });
      return callIndex > lastUser;
    });
    if (!clientCallsMatch) continue;
    const originalUser = state.items.findLast(value => {
      const item = object(value);
      return item?.role === "user"
        && object(item.internal_chat_message_metadata_passthrough)?.turn_id === identity.turnId;
    });
    if (userContent(originalUser) !== clientUserText) continue;
    if (matched && (matched.genericIdentity?.threadId !== identity.threadId
      || matched.genericIdentity?.turnId !== identity.turnId)) return body;
    matched ??= state;
  }
  if (!matched?.genericIdentity) return body;
  const expanded = { ...request, input: [...matched.items, ...results] };
  replayedInputPrefixLengths.set(expanded, matched.items.length);
  replayedGenericIdentities.set(expanded, matched.genericIdentity);
  return expanded;
}

function pruneResponses(at = now()): void {
  for (const [id, state] of states) {
    if (at - state.createdAt > RESPONSE_TTL_MS) deleteEntry(id);
  }
  while (states.size > MAX_STORED_RESPONSES) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    deleteEntry(oldest);
  }
  // Byte high-water eviction, oldest-first (Map preserves insertion order).
  while (storedResponseBytes > MAX_STORED_RESPONSE_BYTES && states.size > 1) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    deleteEntry(oldest);
  }
}

export function expandPreviousResponseInput(body: unknown, owner: "native" | "generic"): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const request = body as Record<string, unknown>;
  const previousId = typeof request.previous_response_id === "string" ? request.previous_response_id : undefined;
  if (!previousId) return body;
  ensureLoaded();
  pruneResponses();
  const previous = states.get(previousId);
  if (!previous) return body;
  // A response ID is a continuation reference, not proof of native Codex authority.
  // Keep locally cached native history out of the generic API and prevent native
  // turns from absorbing synthetic generic browser ownership on replay.
  if (Boolean(previous.genericIdentity) !== (owner === "generic")) return body;
  const expanded = {
    ...request,
    input: [...previous.items, ...inputItems(request.input)],
  };
  replayedInputPrefixLengths.set(expanded, previous.items.length);
  if (previous.genericIdentity) replayedGenericIdentities.set(expanded, previous.genericIdentity);
  return expanded;
}

/** Number of leading input items restored from previous_response_id state for this exact body. */
export function previousResponseReplayPrefixLength(body: unknown): number {
  if (!body || typeof body !== "object" || Array.isArray(body)) return 0;
  return replayedInputPrefixLengths.get(body) ?? 0;
}

/** The browser owner associated with an expanded, locally retained generic response. */
export function previousResponseGenericIdentity(body: unknown): GenericResponseIdentity | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  return replayedGenericIdentities.get(body);
}

/**
 * Cache completed output and max_output_tokens partial output for previous_response_id replay.
 * Content-filtered incomplete and failed output are not authoritative replay history.
 */
export function rememberResponseState(
  requestBody: unknown,
  response: { id?: unknown; output?: unknown; status?: unknown; incomplete_details?: unknown },
  opts?: { force?: boolean; genericIdentity?: GenericResponseIdentity },
): void {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return;
  const request = requestBody as Record<string, unknown>;
  // `force` bypasses only the store:false skip: Codex sends `store:false` on every non-Azure
  // HTTP request (and WS inherits it), yet its WS turns still chain with previous_response_id.
  // The passthrough branch records with force so those chains can be expanded locally; the
  // store stays in-memory with a 1h TTL, so this is a proxy-internal continuation cache, not
  // real server-side response storage.
  if (request.store === false && !opts?.force) return;
  if (typeof response.id !== "string" || !Array.isArray(response.output)) return;
  if (response.status === "incomplete") {
    const details = response.incomplete_details;
    if (!details || typeof details !== "object" || Array.isArray(details)
      || (details as { reason?: unknown }).reason !== "max_output_tokens") return;
  } else if (response.status !== undefined && response.status !== "completed") return;
  ensureLoaded();
  setEntry(response.id, {
    createdAt: now(),
    items: [...inputItems(request.input), ...response.output],
    ...(isGenericIdentity(opts?.genericIdentity) ? { genericIdentity: opts?.genericIdentity } : {}),
    ...(typeof request.model === "string" ? { modelId: request.model } : {}),
  });
  pruneResponses();
  schedulePersist();
}
