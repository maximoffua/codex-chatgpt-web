/**
 * codex-chatgpt-web provider extension for pi.
 *
 * Talks to a codex-chatgpt-web Responses bridge (https://github.com/miuuyy/codex-chatgpt-web),
 * which proxies the OpenAI Responses API through a logged-in ChatGPT web session.
 *
 * Connection resolution (first match wins):
 *   1. $CODEX_CHATGPT_WEB_URL=http(s)://…       direct bridge URL
 *      $CODEX_CHATGPT_WEB_URL=ssh://[user@]host[:sshPort]/[remoteHost:remotePort]
 *                                               automatic SSH local-forward tunnel;
 *                                               remote also via ?remote=host:port or #host:port,
 *                                               default remote 127.0.0.1:$CODEX_CHATGPT_WEB_REMOTE_PORT | 17841
 *   2. $CODEX_CHATGPT_WEB_SSH=[user@]host[:port] tunnel (with $CODEX_CHATGPT_WEB_REMOTE=host:port)
 *   3. ~/.codex-chatgpt-web/config.json: { host, port } direct, or
 *      { sshTunnel: "[user@]host[:port]", sshRemote: "host:port" } for a tunnel
 *   Fallback: http://127.0.0.1:17841/v1
 *
 * Models are fetched live from GET /v1/models. Per-model metadata (context window,
 * supported thinking efforts) comes from a static table mirroring the bridge's catalog
 * (chatgpt-web-models.ts); /v1/models rows carry no capability fields today.
 *
 * Session affinity: pi's session id is sent as `x-session-id`; the bridge keeps all turns
 * of a pi session on one ChatGPT web conversation. Function tools require the bridge in
 * Full (MCP harness) mode; Browser-only mode returns 409.
 *
 * Codex-native alias tools (`exec_command`, `apply_patch`) let the ChatGPT-side model's
 * codex_exec / codex_apply_patch bridge calls bind to real local execution; the bridge's
 * MCP surface resolves those exact names against the caller's tool registry.
 *
 * Selftest (no network): bun pi-extension/codex-chatgpt-web.ts --selftest
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_BRIDGE_PORT = 17841;

// ---------------------------------------------------------------------------
// Connection resolution + SSH tunnel
// ---------------------------------------------------------------------------

export interface TunnelSpec {
  /** ssh destination: [user@]host[:port] */
  target: string;
  remoteHost: string;
  remotePort: number;
}

export function parseSshTarget(value: string): { target: string; port?: number } {
  const cleaned = value.trim().replace(/^ssh:\/\//, "").replace(/\/+$/, "");
  const lastColon = cleaned.lastIndexOf(":");
  if (lastColon > 0 && /^\d+$/.test(cleaned.slice(lastColon + 1))) {
    const host = cleaned.slice(0, lastColon);
    if (host.includes("@") || host.includes(".")) return { target: host, port: Number(cleaned.slice(lastColon + 1)) };
  }
  return { target: cleaned };
}

/** Parse `ssh://[user@]host[:port][/remoteHost:remotePort]` (remote also via ?remote= / #). */
export function parseTunnelUrl(value: string, defaultRemote: { host: string; port: number }): TunnelSpec | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("ssh://")) return undefined;
  let rest = trimmed.slice("ssh://".length);
  let remoteHost = defaultRemote.host;
  let remotePort = defaultRemote.port;
  // fragment or query remote
  const hashAt = rest.indexOf("#");
  const queryAt = rest.indexOf("?");
  const cutAt = hashAt >= 0 ? hashAt : queryAt;
  if (cutAt >= 0) {
    const tail = rest.slice(cutAt + 1);
    rest = rest.slice(0, cutAt);
    const remote = hashAt >= 0 ? tail : new URLSearchParams(tail).get("remote");
    if (remote) {
      const parsed = splitRemote(remote, defaultRemote);
      remoteHost = parsed.host;
      remotePort = parsed.port;
    }
  }
  // path remote
  const slashAt = rest.indexOf("/");
  if (slashAt >= 0) {
    const pathRemote = rest.slice(slashAt + 1);
    rest = rest.slice(0, slashAt);
    if (pathRemote.trim() !== "") {
      const parsed = splitRemote(pathRemote, defaultRemote);
      remoteHost = parsed.host;
      remotePort = parsed.port;
    }
  }
  const { target, port } = parseSshTarget(rest);
  if (target === "") return undefined;
  return { target: port !== undefined ? `${target}:${port}` : target, remoteHost, remotePort };
}

function splitRemote(value: string, fallback: { host: string; port: number }): { host: string; port: number } {
  const cleaned = value.trim();
  const lastColon = cleaned.lastIndexOf(":");
  if (lastColon > 0 && /^\d+$/.test(cleaned.slice(lastColon + 1))) {
    return { host: cleaned.slice(0, lastColon), port: Number(cleaned.slice(lastColon + 1)) };
  }
  return cleaned === "" ? fallback : { host: cleaned, port: fallback.port };
}

interface BridgeConfig {
  host?: string;
  port?: number;
  sshTunnel?: string;
  sshRemote?: string;
}

function readBridgeConfig(): BridgeConfig {
  try {
    const configPath = join(homedir(), ".codex-chatgpt-web", "config.json");
    return JSON.parse(readFileSync(configPath, "utf-8")) as BridgeConfig;
  } catch {
    return {};
  }
}

export interface ResolvedConnection {
  /** Direct base URL (tunnel local forward when tunneled), without trailing /v1 */
  baseUrl: string;
  tunnel?: TunnelSpec;
}

function defaultRemote(config: BridgeConfig): { host: string; port: number } {
  const envRemote = process.env.CODEX_CHATGPT_WEB_REMOTE?.trim();
  if (envRemote) return splitRemote(envRemote, { host: "127.0.0.1", port: config.port ?? DEFAULT_BRIDGE_PORT });
  if (config.sshRemote) return splitRemote(config.sshRemote, { host: "127.0.0.1", port: config.port ?? DEFAULT_BRIDGE_PORT });
  return { host: "127.0.0.1", port: config.port ?? DEFAULT_BRIDGE_PORT };
}

export function resolveConnection(): ResolvedConnection {
  const config = readBridgeConfig();
  const remote = defaultRemote(config);
  const envUrl = process.env.CODEX_CHATGPT_WEB_URL?.trim();
  if (envUrl) {
    const tunnel = parseTunnelUrl(envUrl, remote);
    if (tunnel) return { baseUrl: `http://127.0.0.1:${remote.port}`, tunnel };
    return { baseUrl: envUrl.replace(/\/+$/, "").replace(/\/v1$/, "") };
  }
  const envSsh = process.env.CODEX_CHATGPT_WEB_SSH?.trim();
  if (envSsh) {
    const { target, port } = parseSshTarget(envSsh);
    return { baseUrl: `http://127.0.0.1:${remote.port}`, tunnel: { target: port !== undefined ? `${target}:${port}` : target, remoteHost: remote.host, remotePort: remote.port } };
  }
  if (config.sshTunnel) {
    const { target, port } = parseSshTarget(config.sshTunnel);
    const tunnelRemote = config.sshRemote ? splitRemote(config.sshRemote, remote) : remote;
    return { baseUrl: `http://127.0.0.1:${remote.port}`, tunnel: { target: port !== undefined ? `${target}:${port}` : target, remoteHost: tunnelRemote.host, remotePort: tunnelRemote.port } };
  }
  return { baseUrl: `http://${config.host ?? "127.0.0.1"}:${config.port ?? DEFAULT_BRIDGE_PORT}` };
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Establish an SSH local-forward tunnel and return the local base URL.
 * Throws if ssh exits or the bridge never answers /v1/models through the tunnel.
 */
export async function startTunnel(spec: TunnelSpec, healthTimeoutMs = 20_000): Promise<{ baseUrl: string; child: ChildProcess }> {
  const localPort = await findFreePort();
  const child = spawn("ssh", [
    "-N",
    "-L", `127.0.0.1:${localPort}:${spec.remoteHost}:${spec.remotePort}`,
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
    "-o", "StrictHostKeyChecking=accept-new",
    spec.target,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let sshError = "";
  child.stderr?.on("data", (chunk: Buffer) => { sshError += chunk.toString(); });
  const exited = new Promise<number | null>(resolve => child.on("exit", code => resolve(code)));
  const baseUrl = `http://127.0.0.1:${localPort}`;
  const deadline = Date.now() + healthTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`ssh tunnel to ${spec.target} exited (${child.exitCode}): ${sshError.trim().slice(0, 300)}`);
    try {
      const response = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return { baseUrl, child };
    } catch {
      // tunnel not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  child.kill("SIGTERM");
  void exited;
  throw new Error(`bridge at ${spec.remoteHost}:${spec.remotePort} did not answer through ssh tunnel to ${spec.target} within ${healthTimeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Model metadata (mirrors the bridge catalog; /v1/models rows carry no capability fields)
// ---------------------------------------------------------------------------

interface ModelMeta {
  /** pi thinking level -> provider effort sent on the wire */
  efforts: Record<string, string>;
  contextWindow: number;
  maxTokens?: number;
  input?: string[];
}

/** Pro account, Bigger Context on. Values from src/chatgpt-web-models.ts constants. */
const MODEL_META: Record<string, ModelMeta> = {
  "chatgpt-low": { efforts: { low: "low" }, contextWindow: 111_193 },
  "chatgpt-medium": { efforts: { medium: "medium" }, contextWindow: 240_000 },
  "chatgpt-high": { efforts: { high: "high" }, contextWindow: 240_000 },
  "chatgpt-xhigh": { efforts: { xhigh: "xhigh" }, contextWindow: 240_000 },
  "chatgpt-pro": { efforts: { max: "max" }, contextWindow: 112_193 },
  "chatgpt-web/gpt-6-sol-instant": { efforts: { low: "low" }, contextWindow: 111_193 },
  "chatgpt-web/gpt-6-sol": { efforts: { medium: "medium", high: "high", xhigh: "xhigh" }, contextWindow: 240_000 },
  "chatgpt-web/gpt-5.6-sol-instant": { efforts: { low: "low" }, contextWindow: 333_579 },
  "chatgpt-web/gpt-5.6-sol": { efforts: { medium: "medium", high: "high", xhigh: "xhigh" }, contextWindow: 333_579 },
  "chatgpt-web/gpt-5.6-pro": { efforts: { max: "max" }, contextWindow: 112_193 },
  "chatgpt-web/gpt-6-pro": { efforts: { max: "max" }, contextWindow: 112_193 },
  // Luna uses a rolling checkpoint; advertise the 3x staged budget, not its 1M window
  "chatgpt-web/gpt-5.6-luna": { efforts: { low: "low", medium: "medium" }, contextWindow: 84_000 },
};

const FALLBACK_MODELS = ["chatgpt-low", "chatgpt-medium", "chatgpt-high", "chatgpt-xhigh", "chatgpt-pro"];

function modelConfig(id: string, name: string | undefined): ReturnType<typeof buildModelConfig> {
  return buildModelConfig(id, name, undefined);
}

function buildModelConfig(id: string, name: string | undefined, live: { context_window?: number; input_modalities?: string[] } | undefined) {
  const meta = MODEL_META[id];
  const input = live?.input_modalities ?? meta?.input ?? ["text", "image"];
  return {
    id,
    name: name ?? id,
    reasoning: true,
    input: input.includes("image") ? (["text", "image"] as const) : (["text"] as const),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // shortcut: /v1/models carries no window; live value wins when the bridge starts exposing it
    contextWindow: live?.context_window ?? meta?.contextWindow ?? 240_000,
    maxTokens: meta?.maxTokens ?? 65_536,
    ...(meta ? { thinkingLevelMap: meta.efforts } : {}),
    compat: {
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openrouter" as const, // x-session-id header the bridge reads
    },
  };
}

// ---------------------------------------------------------------------------
// Codex-native alias tools
// ---------------------------------------------------------------------------

// shortcut: bridge broker retires the MCP invocation after 90s; keep spawn below that
const COMMAND_TIMEOUT_MAX_MS = 85_000;
const OUTPUT_CAP_DEFAULT_CHARS = 50_000;

// Plain JSON schemas (same wire shape typebox Type.Object produces) so the file has no deps.
const ExecCommandParams = {
  type: "object",
  properties: {
    cmd: { type: "string", minLength: 1 },
    workdir: { type: "string" },
    yield_time_ms: { type: "number" },
    max_output_tokens: { type: "number" },
    tty: { type: "boolean" },
    sandbox_permissions: { type: "string", enum: ["use_default", "require_escalated"] },
    justification: { type: "string" },
    prefix_rule: { type: "array", items: { type: "string" } },
  },
  required: ["cmd"],
} as const;

type ExecCommandInput = {
  cmd: string;
  workdir?: string;
  yield_time_ms?: number;
  max_output_tokens?: number;
  tty?: boolean;
  sandbox_permissions?: string;
  justification?: string;
  prefix_rule?: string[];
};

type PatchOp =
  | { op: "update"; path: string; hunks: { oldSeq: string[]; newSeq: string[] }[] }
  | { op: "add"; path: string; content: string }
  | { op: "delete"; path: string };

class PatchError extends Error {}

/** Parse the Codex apply_patch format (*** Begin Patch / Update|Add|Delete File / End Patch). */
export function parseCodexPatch(input: string): PatchOp[] {
  const lines = input.split(/\r?\n/);
  if (lines[0]?.trim() !== "*** Begin Patch") {
    throw new PatchError("Patch must start with '*** Begin Patch'");
  }
  const ops: PatchOp[] = [];
  let i = 1;
  let current: { op: PatchOp; hunks: { oldSeq: string[]; newSeq: string[] }[]; raw: string[] } | undefined;
  const flushUpdate = () => {
    if (!current || current.op.op !== "update") return;
    current.op.hunks = hunksFromBody(current.raw);
    ops.push(current.op);
  };
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "*** End Patch") break;
    if (line.startsWith("*** Update File: ")) {
      flushUpdate();
      current = { op: { op: "update", path: line.slice("*** Update File: ".length).trim(), hunks: [] }, hunks: [], raw: [] };
    } else if (line.startsWith("*** Add File: ")) {
      flushUpdate();
      current = { op: { op: "add", path: line.slice("*** Add File: ".length).trim(), content: "" }, hunks: [], raw: [] };
      ops.push(current.op);
      current = undefined;
      // collect '+' body until next marker
      let content: string[] = [];
      for (i = i + 1; i < lines.length; i++) {
        const body = lines[i]!;
        if (body.startsWith("***")) { i--; break; }
        if (body.startsWith("+")) content.push(body.slice(1));
        else throw new PatchError(`Add File body line must start with '+': ${body.slice(0, 60)}`);
      }
      if (ops[ops.length - 1] && ops[ops.length - 1]!.op === "add") (ops[ops.length - 1] as { content: string }).content = content.join("\n");
    } else if (line.startsWith("*** Delete File: ")) {
      flushUpdate();
      ops.push({ op: "delete", path: line.slice("*** Delete File: ".length).trim() });
      current = undefined;
    } else if (line.startsWith("***")) {
      throw new PatchError(`Unsupported patch directive: ${line.slice(0, 60)}`);
    } else if (current) {
      current.raw.push(line);
    } else if (line.trim() !== "") {
      // Silent drops would let a malformed patch report Success while ignoring edits
      throw new PatchError(`Unexpected line outside a file section: ${line.slice(0, 60)}`);
    }
  }
  flushUpdate();
  if (ops.length === 0) throw new PatchError("Patch contains no file operations");
  return ops;
}

function hunksFromBody(raw: string[]): { oldSeq: string[]; newSeq: string[] }[] {
  const hunks: { oldSeq: string[]; newSeq: string[] }[] = [{ oldSeq: [], newSeq: [] }];
  for (const line of raw) {
    const hunk = hunks[hunks.length - 1]!;
    if (line.startsWith("@@")) {
      if (hunk.oldSeq.length > 0 || hunk.newSeq.length > 0) hunks.push({ oldSeq: [], newSeq: [] });
    } else if (line.startsWith("+")) {
      hunk.newSeq.push(line.slice(1));
    } else if (line.startsWith("-")) {
      hunk.oldSeq.push(line.slice(1));
    } else {
      // context line: single leading space is a prefix artifact, strip one
      const ctx = line.startsWith(" ") ? line.slice(1) : line;
      hunk.oldSeq.push(ctx);
      hunk.newSeq.push(ctx);
    }
  }
  const kept = hunks.filter(h => h.oldSeq.length > 0 || h.newSeq.length > 0);
  if (kept.some(h => h.oldSeq.length === 0)) {
    // A context-free hunk would splice at the search cursor (top of file) — silent corruption
    throw new PatchError("Update hunks require at least one context or '-' line to anchor them");
  }
  return kept;
}

function findSubrange(haystack: string[], needle: string[], from: number): number {
  if (needle.length === 0) return from;
  outer: for (let start = from; start <= haystack.length - needle.length; start++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[start + j] !== needle[j]) continue outer;
    }
    return start;
  }
  return -1;
}

function applyPatch(input: string, baseDir: string): string[] {
  const ops = parseCodexPatch(input);
  // validate everything first, then write — no partial patches
  const planned: { path: string; lines?: string[]; eol?: string }[] = [];
  for (const op of ops) {
    const abs = join(baseDir, op.path);
    if (op.op === "add") {
      if (existsSync(abs)) throw new PatchError(`Add File target already exists: ${op.path}`);
      planned.push({ path: abs, lines: op.content.length === 0 ? [] : op.content.split("\n"), eol: "\n" });
    } else if (op.op === "delete") {
      if (!existsSync(abs)) throw new PatchError(`Delete File target does not exist: ${op.path}`);
      planned.push({ path: abs, lines: undefined });
    } else {
      if (!existsSync(abs)) throw new PatchError(`Update File target does not exist: ${op.path}`);
      const raw = readFileSync(abs, "utf-8");
      const eol = raw.includes("\r\n") ? "\r\n" : "\n";
      const fileLines = raw.split(/\r?\n/);
      // trailing newline convention: last element after split is "" for newline-terminated files
      const hadTrailingNewline = fileLines.length > 0 && fileLines[fileLines.length - 1] === "";
      const body = hadTrailingNewline ? fileLines.slice(0, -1) : fileLines;
      let cursor = 0;
      for (const hunk of op.hunks) {
        const at = findSubrange(body, hunk.oldSeq, cursor);
        if (at < 0) throw new PatchError(`Context not found in ${op.path}: ${JSON.stringify(hunk.oldSeq.slice(0, 3))}`);
        body.splice(at, hunk.oldSeq.length, ...hunk.newSeq);
        cursor = at + hunk.newSeq.length;
      }
      planned.push({ path: abs, lines: hadTrailingNewline ? [...body, ""] : body, eol });
    }
  }
  const summary: string[] = [];
  for (const item of planned) {
    if (item.lines === undefined) {
      unlinkSync(item.path);
      summary.push(`deleted ${item.path}`);
    } else {
      writeFileSync(item.path, item.lines!.join(item.eol ?? "\n"));
      summary.push(`wrote ${item.path} (${item.lines!.length} lines)`);
    }
  }
  return summary;
}

export async function runExecCommand(params: ExecCommandInput, signal?: AbortSignal): Promise<string> {
  const started = Date.now();
  // yield_time_ms is the caller's polling hint, not a kill deadline; commands run to completion
  const timeoutMs = COMMAND_TIMEOUT_MAX_MS;
  const cap = Math.min(params.max_output_tokens ?? OUTPUT_CAP_DEFAULT_CHARS, 200_000);
  const shell = process.env.SHELL && process.env.SHELL.trim() !== "" ? process.env.SHELL : "/bin/sh";
  const child = spawn(shell, ["-c", params.cmd], {
    cwd: params.workdir && params.workdir.trim() !== "" ? params.workdir : process.cwd(),
    env: process.env,
  });
  let out = "";
  const capture = (chunk: Buffer) => {
    if (out.length < cap) out += chunk.toString();
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2_000);
  }, timeoutMs);
  const onAbort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", onAbort, { once: true });
  const exitCode = await new Promise<number | null>(resolve => {
    child.on("close", code => resolve(code));
    child.on("error", () => resolve(-1));
  });
  clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);
  if (out.length > cap) out = `${out.slice(0, cap)}\n[output truncated at ${cap} chars]`;
  return JSON.stringify({
    output: out,
    exit_code: exitCode ?? (signal?.aborted ? 130 : -1),
    duration_ms: Date.now() - started,
    ...(timedOut ? { timed_out: true, timeout_ms: timeoutMs } : {}),
    // shortcut: no session support, long-running commands must finish within the timeout
    note: "exec_command runs each command to completion; session_id/write_stdin are not supported.",
  });
}

function registerCodexAliasTools(pi: ExtensionAPI): void {
  // Codex-native aliases: the ChatGPT-side bridge (codex_exec/codex_apply_patch MCP tools)
  // resolves these exact names against pi's advertised tool registry.
  pi.registerTool({
    name: "exec_command",
    label: "exec_command (codex bridge alias)",
    description:
      "Run a shell command and wait for completion. Returns JSON {output, exit_code, duration_ms}. "
      + "Approval fields (sandbox_permissions/justification/prefix_rule) are accepted but execution is local and unsandboxed. "
      + "Long-running sessions are not supported; each call runs to completion.",
    parameters: ExecCommandParams,
    async execute(_toolCallId: string, params: ExecCommandInput, signal?: AbortSignal) {
      return {
        content: [{ type: "text", text: await runExecCommand(params, signal) }],
        details: { cmd: params.cmd },
      };
    },
  });

  pi.registerTool({
    name: "apply_patch",
    label: "apply_patch (codex bridge alias)",
    description:
      "Apply a Codex-format patch (*** Begin Patch / *** Update File|*** Add File|*** Delete File / *** End Patch) "
      + "relative to the current workspace. Either all operations apply or none do.",
    parameters: {
      type: "object",
      properties: { input: { type: "string", minLength: 1 } },
      required: ["input"],
    } as const,
    async execute(_toolCallId: string, params: { input: string }) {
      try {
        const summary = applyPatch(params.input, process.cwd());
        return {
          content: [{ type: "text", text: `Success. ${summary.join("; ")}` }],
          details: { applied: summary.length },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Patch failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { applied: 0 },
        };
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  const connection = resolveConnection();
  let baseUrl = connection.baseUrl;

  let tunnelChild: ChildProcess | undefined;
  if (connection.tunnel) {
    try {
      const tunnel = await startTunnel(connection.tunnel);
      baseUrl = tunnel.baseUrl;
      tunnelChild = tunnel.child;
      const killTunnel = () => tunnelChild?.kill("SIGTERM");
      process.once("exit", killTunnel);
      process.once("SIGINT", () => { killTunnel(); process.exit(0); });
      process.once("SIGTERM", () => { killTunnel(); process.exit(0); });
      console.error(`[codex-chatgpt-web] ssh tunnel to ${connection.tunnel.target} -> ${connection.tunnel.remoteHost}:${connection.tunnel.remotePort} on ${baseUrl}`);
    } catch (error) {
      console.error(`[codex-chatgpt-web] ssh tunnel failed: ${error instanceof Error ? error.message : String(error)}; falling back to ${baseUrl}`);
    }
  }

  let models = FALLBACK_MODELS.map(id => modelConfig(id, undefined));
  try {
    const response = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(5_000) });
    if (response.ok) {
      const payload = (await response.json()) as {
        data?: Array<{ id: string; name?: string; context_window?: number; input_modalities?: string[] }>;
      };
      const rows = payload.data ?? [];
      if (rows.length > 0) {
        models = rows.map(row => buildModelConfig(row.id, row.name, row));
      }
    }
  } catch {
    // Bridge not reachable; keep fallback list so /model still shows entries.
  }

  pi.registerProvider("codex-chatgpt-web", {
    name: "ChatGPT Web (codex-chatgpt-web)",
    baseUrl,
    // Bridge ignores auth on /v1/responses; key only satisfies the provider contract.
    apiKey: "local-bridge",
    api: "openai-responses",
    models,
  });

  registerCodexAliasTools(pi);
}

// ---------------------------------------------------------------------------
// Selftest: bun pi-extension/codex-chatgpt-web.ts --selftest
// ---------------------------------------------------------------------------

if (process.argv[1]?.endsWith("codex-chatgpt-web.ts") && process.argv.includes("--selftest")) {
  const dir = mkdtempSync(join(tmpdir(), "ccw-ext-"));
  const failures: string[] = [];
  const check = async (name: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`FAIL - ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const expectThrows = (fn: () => void, marker: string) => {
    try {
      fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(marker)) throw new Error(`expected error containing '${marker}', got '${message}'`);
      return;
    }
    throw new Error(`expected error containing '${marker}', none thrown`);
  };
  const eq = (actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  try {
    await check("tunnel url: bare host", () => {
      eq(parseTunnelUrl("ssh://bastion", { host: "127.0.0.1", port: 17841 }), { target: "bastion", remoteHost: "127.0.0.1", remotePort: 17841 });
    });
    await check("tunnel url: user, ssh port, path remote", () => {
      eq(parseTunnelUrl("ssh://user@host:2222/10.0.0.5:9000", { host: "127.0.0.1", port: 17841 }), { target: "user@host:2222", remoteHost: "10.0.0.5", remotePort: 9000 });
    });
    await check("tunnel url: query remote", () => {
      eq(parseTunnelUrl("ssh://h?remote=127.0.0.1:9999", { host: "127.0.0.1", port: 17841 }), { target: "h", remoteHost: "127.0.0.1", remotePort: 9999 });
    });
    await check("tunnel url: fragment remote", () => {
      eq(parseTunnelUrl("ssh://h#127.0.0.1:9999", { host: "127.0.0.1", port: 17841 }), { target: "h", remoteHost: "127.0.0.1", remotePort: 9999 });
    });
    await check("tunnel url: http is direct", () => {
      eq(parseTunnelUrl("http://127.0.0.1:17841/v1", { host: "127.0.0.1", port: 17841 }), undefined);
    });
    await check("ssh target with port", () => {
      eq(parseSshTarget("user@host:2222"), { target: "user@host", port: 2222 });
    });
    await check("ssh target without port", () => {
      eq(parseSshTarget("user@host"), { target: "user@host", port: undefined });
    });
    await check("update file", () => {
      writeFileSync(join(dir, "a.txt"), "alpha\nbeta\ngamma\n");
      applyPatch(
        "*** Begin Patch\n*** Update File: a.txt\n@@\n alpha\n-beta\n+BETA\n*** End Patch\n",
        dir,
      );
      const after = readFileSync(join(dir, "a.txt"), "utf-8");
      if (after !== "alpha\nBETA\ngamma\n") throw new Error(`unexpected content: ${JSON.stringify(after)}`);
    });
    await check("multi-hunk update", () => {
      writeFileSync(join(dir, "b.txt"), "one\ntwo\nthree\nfour\nfive\n");
      applyPatch(
        "*** Begin Patch\n*** Update File: b.txt\n@@\n-one\n+ONE\n@@\n-four\n+FOUR\n*** End Patch\n",
        dir,
      );
      const after = readFileSync(join(dir, "b.txt"), "utf-8");
      if (after !== "ONE\ntwo\nthree\nFOUR\nfive\n") throw new Error(`unexpected content: ${JSON.stringify(after)}`);
    });
    await check("add + delete", () => {
      writeFileSync(join(dir, "c.txt"), "x\n");
      applyPatch(
        "*** Begin Patch\n*** Add File: new.txt\n+hello\n+world\n*** Delete File: c.txt\n*** End Patch\n",
        dir,
      );
      if (readFileSync(join(dir, "new.txt"), "utf-8") !== "hello\nworld") throw new Error("add content mismatch");
      if (existsSync(join(dir, "c.txt"))) throw new Error("delete did not remove file");
    });
    await check("missing context fails, no partial write", () => {
      writeFileSync(join(dir, "d.txt"), "keep\n");
      expectThrows(
        () => applyPatch("*** Begin Patch\n*** Update File: d.txt\n@@\n-nope\n+changed\n*** End Patch\n", dir),
        "Context not found",
      );
      if (readFileSync(join(dir, "d.txt"), "utf-8") !== "keep\n") throw new Error("partial write detected");
    });
    await check("bad header rejected", () => {
      expectThrows(() => parseCodexPatch("not a patch"), "Begin Patch");
    });
    await check("missing begin marker rejected", () => {
      expectThrows(() => parseCodexPatch(""), "Begin Patch");
    });
    await check("exec ignores yield_time_ms as kill deadline", async () => {
      const payload = JSON.parse(await runExecCommand({ cmd: "sleep 2; echo done", yield_time_ms: 500 })) as { exit_code: number; output: string };
      if (payload.exit_code !== 0 || !payload.output.includes("done")) throw new Error(`unexpected: ${JSON.stringify(payload)}`);
    });
    await check("crlf file keeps line endings", () => {
      writeFileSync(join(dir, "e.txt"), "alpha\r\nbeta\r\n");
      applyPatch("*** Begin Patch\n*** Update File: e.txt\n@@\r\n alpha\r\n-beta\r\n+BETA\r\n*** End Patch\n", dir);
      const raw = readFileSync(join(dir, "e.txt"), "utf-8");
      if (raw !== "alpha\r\nBETA\r\n") throw new Error(`unexpected content: ${JSON.stringify(raw)}`);
    });
    await check("context-free update hunk rejected", () => {
      writeFileSync(join(dir, "f.txt"), "keep\n");
      expectThrows(
        () => applyPatch("*** Begin Patch\n*** Update File: f.txt\n@@\n+inserted\n*** End Patch\n", dir),
        "at least one context",
      );
    });
    await check("stray line outside section rejected", () => {
      expectThrows(
        () => parseCodexPatch("*** Begin Patch\n*** Delete File: nope.txt\nstray content\n*** End Patch\n"),
        "outside a file section",
      );
    });
    await check("empty patch rejected", () => {
      expectThrows(() => parseCodexPatch("*** Begin Patch\n*** End Patch\n"), "no file operations");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    console.error(`${failures.length} selftest failure(s): ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("all selftests passed");
  process.exit(0);
}
