import { randomUUID } from "node:crypto";
import type { CodexParsedRequest } from "../types";
import type { ChatGptTurnEnvironment } from "../adapters/chatgpt-web/environment";
import type { GenericResponseIdentity } from "./state";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject : undefined;
}

function isClientToolOutput(value: unknown): boolean {
  return ["function_call_output", "custom_tool_call_output", "tool_search_output"]
    .includes(String(object(value)?.type));
}

/**
 * Ordinary OpenAI Responses clients have no native Codex turn provenance. Canonicalize
 * their latest instruction and assign a proxy-owned lifecycle identity. The identity is
 * used only for browser ownership/replay: it does not grant native Codex permissions.
 * Never pass caller-supplied client_metadata through as trusted native authority.
 */
export function prepareOpenAiCompatibleResponseBody(
  value: unknown,
  replayedInputPrefixLength = 0,
  previousIdentity?: GenericResponseIdentity,
): JsonObject {
  const body = object(value);
  if (!body) throw new Error("Responses body must be an object");
  const supplied = Array.isArray(body.input)
    ? body.input
    : typeof body.input === "string"
      ? [{ type: "message", role: "user", content: [{ type: "input_text", text: body.input }] }]
      : [];
  const input = supplied.map(value => {
    const item = object(value);
    return item?.role === "user" && item.type === undefined
      ? { ...item, type: "message" }
      : value;
  });
  if (replayedInputPrefixLength < 0 || replayedInputPrefixLength > input.length) {
    throw new Error("Generic Responses replay prefix is invalid");
  }
  const newInput = input.slice(replayedInputPrefixLength);
  const currentIndex = newInput.findLastIndex(value => {
    const item = object(value);
    return item?.type === "message" && item.role === "user";
  });
  if (newInput.length === 0) {
    throw new Error("Responses input requires a current user message or tool output");
  }
  // A tool-output-only continuation of our previous response belongs to the same
  // browser turn: that session still owns the pending call and must receive its
  // result. Keep the exact original user revision and its ID so execution keys
  // match. A new user instruction starts a new turn in the same logical thread.
  const toolOnlyContinuation = previousIdentity && currentIndex < 0
    && newInput.every(isClientToolOutput);
  const priorInstruction = previousIdentity && input.slice(0, replayedInputPrefixLength).some(value => {
    const item = object(value);
    return item?.type === "message" && item.role === "user" && typeof item.id === "string"
      && object(item.internal_chat_message_metadata_passthrough)?.turn_id === previousIdentity.turnId;
  });
  const sameTurn = Boolean(toolOnlyContinuation && priorInstruction);
  const turnId = sameTurn ? previousIdentity!.turnId : `turn_generic_${randomUUID().replaceAll("-", "")}`;
  const threadId = previousIdentity?.threadId ?? `thread_generic_${randomUUID().replaceAll("-", "")}`;
  if (!sameTurn) {
    if (currentIndex < 0 || newInput.slice(currentIndex + 1).some(isClientToolOutput)) {
      input.push({ type: "message", role: "user", content: "Continue using the tool result above." });
    }
    const active = input.findLastIndex(value => object(value)?.type === "message" && object(value)?.role === "user");
    const activeItem = object(input[active]);
    if (!activeItem) throw new Error("Responses request has no user instruction");
    input[active] = {
      ...activeItem,
      id: `msg_generic_${randomUUID().replaceAll("-", "")}`,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    };
  }
  const metadata = object(body.client_metadata);
  const { "x-codex-turn-metadata": _untrusted, ...ordinaryMetadata } = metadata ?? {};
  return {
    ...body,
    input,
    client_metadata: {
      ...ordinaryMetadata,
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: "turn", thread_id: threadId, turn_id: turnId,
      }),
    },
  };
}

export function genericReadOnlyEnvironment(parsed: CodexParsedRequest): ChatGptTurnEnvironment {
  if (!parsed._genericOpenAiCompatible) throw new Error("Generic environment requires proxy-issued authority");
  const cwd = process.platform === "win32" ? "C:\\__chatgpt_web_generic__" : "/__chatgpt_web_generic__";
  return {
    cwd,
    roots: [cwd],
    writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    tools: parsed.context.tools ?? [],
  };
}
