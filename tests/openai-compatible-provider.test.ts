import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";
import { genericReadOnlyEnvironment, prepareOpenAiCompatibleResponseBody } from "../src/responses/generic";
import { parseRequest } from "../src/responses/parser";
import { extractChatGptTurnIdentity, extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";

const model = "chatgpt-high";
const config = { ...defaultConfig("full"), solAvailable: true, extraHighAvailable: true, proAvailable: true };

function send(body: Record<string, unknown>, streamed = false) {
  return responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer local-placeholder" },
    body: JSON.stringify({ model, stream: streamed, ...body }),
  }), config, () => ({
    name: "generic-openai-contract-test",
    async runTurn(parsed, _incoming, emit) {
      expect(parsed._genericOpenAiCompatible).toBeTrue();
      const identity = extractChatGptTurnIdentity(parsed);
      expect(identity.threadId).toStartWith("thread_generic_");
      expect(identity.turnId).toStartWith("turn_generic_");
      const environment = genericReadOnlyEnvironment(parsed);
      expect(environment.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
      expect(environment.writableRoots).toEqual([]);
      expect(environment.cwd).toContain("__chatgpt_web_generic__");
      expect(extractChatGptTurnUserRevision(parsed)).toBeDefined();
      emit({ type: "text_delta", text: "bridge-ok", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }), { rememberState: false });
}

test("generic shorthand input gets its own current-turn user message", async () => {
  const canonical = prepareOpenAiCompatibleResponseBody({ model, input: [{ role: "user", content: "hello" }] });
  const input = canonical.input as Array<Record<string, unknown>>;
  expect(input[0]!.type).toBe("message");
  expect(input[0]!.id).toStartWith("msg_generic_");
  expect(input[0]!.internal_chat_message_metadata_passthrough).toEqual({
    turn_id: expect.stringContaining("turn_generic_"),
  });
  const response = await send({ input: "hello" });
  expect(response.status).toBe(200);
  const data = await response.json() as { model: string; status: string; output: unknown[] };
  expect(data.status).toBe("completed");
  expect(data.model).toBe(model);
  expect(data.output).toContainEqual(expect.objectContaining({
    type: "message", role: "assistant",
    content: [expect.objectContaining({ type: "output_text", text: "bridge-ok" })],
  }));
});

test("generic SSE emits a completed OpenAI Responses event", async () => {
  const response = await send({ input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }] }, true);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const text = await response.text();
  expect(text).toContain("event: response.output_text.delta");
  expect(text).toContain("event: response.completed");
  expect(text).toContain("bridge-ok");
});

test("generic tool-output continuation retains function result and adds new instruction", async () => {
  const response = await send({ input: [
    { type: "message", role: "user", content: "Look up the key" },
    { type: "function_call", call_id: "call_lookup", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call_lookup", output: "key=42" },
  ] });
  expect(response.status).toBe(200);
  expect((await response.json()).status).toBe("completed");
  const body = prepareOpenAiCompatibleResponseBody({ input: [
    { type: "function_call_output", call_id: "call_lookup", output: "key=42" },
  ] });
  expect((body.input as unknown[]).at(-1)).toMatchObject({
    type: "message", role: "user", content: "Continue using the tool result above.",
  });
  const history = [{ type: "message", role: "user", content: "Original user instruction", id: "msg_historical" }];
  expect(() => prepareOpenAiCompatibleResponseBody({ input: history }, 1))
    .toThrow("requires a current user message or tool output");
  const continued = prepareOpenAiCompatibleResponseBody({ input: [
    ...history, { type: "function_call_output", call_id: "call_lookup", output: "key=42" },
  ] }, 1);
  expect((continued.input as Array<{ id?: string }>)[0]!.id).toBe("msg_historical");
  expect((continued.input as unknown[]).at(-1)).toMatchObject({ role: "user", type: "message" });
});

test("generic full-history custom tools and tool search advance the active user revision", () => {
  const current = { role: "user", content: "Find and run the requested tool" };
  for (const result of [
    { type: "custom_tool_call_output", call_id: "custom_1", output: "completed" },
    { type: "tool_search_output", call_id: "search_1", status: "completed", tools: [] },
  ]) {
    const prepared = prepareOpenAiCompatibleResponseBody({ input: [current, result] });
    const input = prepared.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(3);
    expect(input[0]).toMatchObject({ type: "message", role: "user", content: current.content });
    expect(input[0]!.internal_chat_message_metadata_passthrough).toBeUndefined();
    expect(input[1]).toEqual(result);
    expect(input[2]).toMatchObject({
      type: "message", role: "user", content: "Continue using the tool result above.",
      id: expect.stringContaining("msg_generic_"),
      internal_chat_message_metadata_passthrough: { turn_id: expect.stringContaining("turn_generic_") },
    });
    const parsed = parseRequest({ model, ...prepared });
    expect(parsed.context.messages.map(message => message.role)).toEqual(["user", "toolResult", "user"]);
    expect(parsed.context.messages.at(-1)).toMatchObject({
      role: "user", content: "Continue using the tool result above.",
    });
  }
});
