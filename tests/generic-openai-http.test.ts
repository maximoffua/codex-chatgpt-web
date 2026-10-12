import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";
import { extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { chatGptTurnExecutionKey, chatGptTurnRoundKey } from "../src/adapters/chatgpt-web/turn-execution";
import { rememberResponseState } from "../src/responses/state";
import { asChatCompletionSSE } from "../src/chat-completions";
import { createChatGptStructuredOutputValidator } from "../src/adapters/chatgpt-web/output-validation";

const originalHome = process.env.CODEX_CHATGPT_WEB_HOME;
const testHome = mkdtempSync(join(tmpdir(), "cgw-generic-http-"));
beforeAll(() => { process.env.CODEX_CHATGPT_WEB_HOME = testHome; });
afterAll(() => {
  if (originalHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = originalHome;
  rmSync(testHome, { recursive: true });
});

test("HTTP /v1/models serves standard local discovery while native OAuth still proxies upstream", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0, solAvailable: true, proAvailable: true, extraHighAvailable: true };
  let upstreamCalls = 0;
  const server = startServer(config, {
    fetchUpstream: async request => {
      upstreamCalls++;
      expect(request.headers.get("authorization")).toBe("Bearer real-native-token");
      return Response.json({ models: [{
        slug: "native-model", visibility: "list", supported_reasoning_levels: [],
        context_window: 100_000,
      }] });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    for (const authorization of [null, "Bearer local-placeholder", "Bearer no-key-required", "Bearer dummy-actual-local-api-key"]) {
      const headers = new Headers();
      if (authorization) headers.set("authorization", authorization);
      const response = await fetch(`${base}/v1/models`, { headers });
      expect(response.status).toBe(200);
      const list = await response.json() as { object: string; data: Array<{ id: string }> };
      expect(list.object).toBe("list");
      expect(list.data.map(model => model.id)).toContain("chatgpt-high");
      expect(list.data.map(model => model.id)).not.toContain("native-model");
    }
    expect(upstreamCalls).toBe(0);
    const single = await fetch(`${base}/v1/models/chatgpt-high`);
    expect(single.status).toBe(200);
    expect((await single.json()).id).toBe("chatgpt-high");
    expect((await fetch(`${base}/v1/models/unknown`)).status).toBe(404);
    const native = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer real-native-token" } });
    expect(native.status).toBe(200);
    const catalog = await native.json() as { models: Array<{ slug: string }> };
    expect(catalog.models.map(model => model.slug)).toContain("native-model");
    expect(catalog.models.map(model => model.slug)).toContain("chatgpt-high");
    expect(upstreamCalls).toBe(1);
  } finally {
    await server.stop(true);
  }
});

test("Responses replay cannot cross native and generic state ownership", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0, solAvailable: true };
  let adapterCalls = 0;
  const server = startServer(config, {
    adapterFactory: () => ({
      name: "ownership-boundary-test",
      async runTurn() { adapterCalls++; },
    }),
  });
  const url = `http://127.0.0.1:${server.port}/v1/responses`;
  const send = (body: Record<string, unknown>) => fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-low", stream: false, ...body }),
  });
  try {
    const nativeId = `resp_native_${randomUUID()}`;
    rememberResponseState(
      { model: "chatgpt-low", input: [{ type: "message", role: "user", content: "native-only history" }] },
      { id: nativeId, status: "completed", output: [] },
      { force: true },
    );
    const genericRequest = await send({ previous_response_id: nativeId, input: "Generic request" });
    expect(genericRequest.status).toBe(409);
    expect((await genericRequest.json() as { error: { message: string } }).error.message)
      .toContain("Local state for previous_response_id is unavailable");

    const genericId = `resp_generic_${randomUUID()}`;
    rememberResponseState(
      { model: "chatgpt-low", input: [{ type: "message", role: "user", content: "generic-only history" }] },
      { id: genericId, status: "completed", output: [] },
      {
        genericIdentity: {
          threadId: `thread_generic_${"a".repeat(32)}`,
          turnId: `turn_generic_${"b".repeat(32)}`,
        },
      },
    );
    const nativeRequest = await send({
      previous_response_id: genericId,
      input: [{ type: "message", role: "user", content: "Native Codex request" }],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          request_kind: "turn", thread_id: "codex_native_thread", turn_id: "codex_native_turn",
        }),
      },
    });
    expect(nativeRequest.status).toBe(409);
    expect((await nativeRequest.json() as { error: { message: string } }).error.message)
      .toContain("Local continuation state for previous_response_id is unavailable");
    expect(adapterCalls).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test("HTTP /v1/responses accepts generic shorthand text and SSE without native metadata", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0, solAvailable: true };
  const server = startServer(config, {
    adapterFactory: () => ({
      name: "generic-http-test",
      async runTurn(parsed, _incoming, emit) {
        expect(parsed._genericOpenAiCompatible).toBe(true);
        expect(parsed.options.reasoning).toBe("low");
        emit({ type: "text_delta", text: "generic-ok", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    }),
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    for (const stream of [false, true]) {
      const response = await fetch(`${base}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "chatgpt-low", input: "Reply with exactly generic-ok", stream }),
      });
      expect(response.status).toBe(200);
      if (stream) {
        const body = await response.text();
        expect(body).toContain("event: response.completed");
        expect(body).toContain("generic-ok");
      } else {
        const body = await response.json() as { status: string; output: Array<{ content?: Array<{ text?: string }> }> };
        expect(body.status).toBe("completed");
        expect(JSON.stringify(body.output)).toContain("generic-ok");
      }
    }
  } finally {
    await server.stop(true);
  }
});

test("tool outputs continue the original generic browser turn and a new prompt starts another", async () => {
  const config = { ...defaultConfig("full"), port: 0, solAvailable: true };
  const seen: Array<{ threadId?: string; turnId?: string; execution: string; round: string; messages: string }> = [];
  const server = startServer(config, {
    adapterFactory: () => ({
      name: "generic-chained-tool-test",
      async runTurn(parsed, _incoming, emit) {
        seen.push({
          ...extractChatGptTurnIdentity(parsed),
          execution: chatGptTurnExecutionKey(parsed),
          round: chatGptTurnRoundKey(parsed),
          messages: JSON.stringify(parsed.context.messages),
        });
        if (seen.length === 1) {
          emit({ type: "tool_call_start", id: "call_lookup_42", name: "lookup" });
          emit({ type: "tool_call_delta", arguments: "{}" });
          emit({ type: "tool_call_end" });
          emit({ type: "done", stopReason: "tool_use", endTurn: false });
        } else {
          emit({ type: "text_delta", text: `turn-${seen.length}`, phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true });
        }
      },
    }),
  });
  const url = `http://127.0.0.1:${server.port}/v1/responses`;
  const tools = [{ type: "function", name: "lookup", description: "Look up a value", parameters: { type: "object", properties: {} } }];
  const send = async (body: Record<string, unknown>) => {
    const res = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-low", tools, stream: false, ...body }),
    });
    expect(res.status).toBe(200);
    return await res.json() as { id: string; output: Array<{ type: string; call_id?: string }> };
  };
  try {
    const first = await send({ input: "Look up a value" });
    expect(first.output.some(item => item.type === "function_call" && item.call_id === "call_lookup_42")).toBe(true);
    const second = await send({
      previous_response_id: first.id,
      input: [{ type: "function_call_output", call_id: "call_lookup_42", output: "lookup-result=42" }],
    });
    expect(seen[1]!.threadId).toBe(seen[0]!.threadId);
    expect(seen[1]!.turnId).toBe(seen[0]!.turnId);
    expect(seen[1]!.execution).toBe(seen[0]!.execution);
    expect(seen[1]!.round === seen[0]!.round).toBe(false);
    expect(seen[1]!.messages).toContain("lookup-result=42");
    expect(seen[1]!.messages).not.toContain("Continue using the tool result above.");

    await send({ previous_response_id: second.id, input: "What did you find?" });
    expect(seen[2]!.threadId).toBe(seen[0]!.threadId);
    expect(seen[2]!.turnId === seen[0]!.turnId).toBe(false);
    expect(seen[2]!.execution === seen[0]!.execution).toBe(false);
  } finally {
    await server.stop(true);
  }
});

test("stateless Responses clients can return a full transcript and resume the waiting tool call", async () => {
  const config = { ...defaultConfig("full"), port: 0, solAvailable: true };
  // Fresh ids per run: stale states from earlier runs must never match ambiguously.
  const suffix = randomUUID().slice(0, 8);
  const callId = `call_pi_stateless_99_${suffix}`;
  const seen: Array<{ threadId?: string; turnId?: string; execution: string; messages: string }> = [];
  const server = startServer(config, {
    adapterFactory: () => ({
      name: "generic-stateless-tool-test",
      async runTurn(parsed, _incoming, emit) {
        seen.push({
          ...extractChatGptTurnIdentity(parsed),
          execution: chatGptTurnExecutionKey(parsed),
          messages: JSON.stringify(parsed.context.messages),
        });
        if (seen.length === 1) {
          emit({ type: "tool_call_start", id: callId, name: "lookup" });
          emit({ type: "tool_call_delta", arguments: "{}" });
          emit({ type: "tool_call_end" });
          emit({ type: "done", stopReason: "tool_use", endTurn: false });
        } else {
          emit({ type: "text_delta", text: "stateless-done", phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true });
        }
      },
    }),
  });
  const url = `http://127.0.0.1:${server.port}/v1/responses`;
  const tools = [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }];
  const send = async (input: unknown) => {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-low", tools, input, stream: false }),
    });
    expect(response.status).toBe(200);
    return await response.json() as { output: Array<{ type: string; call_id?: string }> };
  };
  try {
    const prompt = `Pi-style stateless tool request ${suffix}`;
    const first = await send(prompt);
    expect(first.output.some(item => item.call_id === callId)).toBe(true);
    await send([
      { role: "user", content: [{ type: "input_text", text: prompt }] },
      { type: "function_call", call_id: callId, name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: callId, output: "pi-value=99" },
    ]);
    expect(seen[1]!.threadId).toBe(seen[0]!.threadId);
    expect(seen[1]!.turnId).toBe(seen[0]!.turnId);
    expect(seen[1]!.execution).toBe(seen[0]!.execution);
    expect(seen[1]!.messages).toContain("pi-value=99");
    expect(seen[1]!.messages).not.toContain("Continue using the tool result above.");

    await send([
      { role: "user", content: [{ type: "input_text", text: "An unrelated user instruction" }] },
      { type: "function_call", call_id: callId, name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: callId, output: "pi-value=100" },
    ]);
    expect(seen[2]!.threadId === seen[0]!.threadId).toBe(false);
  } finally {
    await server.stop(true);
  }
});

test("stateless clients that rewrite call ids but keep item ids resume the same turn", async () => {
  const config = { ...defaultConfig("full"), port: 0, solAvailable: true };
  // Fresh ids per run: stale states from earlier runs must never match ambiguously.
  const daemonCallId = `call_daemon_bridge_7_${randomUUID().slice(0, 8)}`;
  const rewrittenCallId = `call_pi_rewritten_7_${randomUUID().slice(0, 8)}`;
  const seen: Array<{ threadId?: string; turnId?: string; execution: string; messages: string }> = [];
  const server = startServer(config, {
    adapterFactory: () => ({
      name: "generic-stateless-rewritten-id-test",
      async runTurn(parsed, _incoming, emit) {
        seen.push({
          ...extractChatGptTurnIdentity(parsed),
          execution: chatGptTurnExecutionKey(parsed),
          messages: JSON.stringify(parsed.context.messages),
        });
        if (seen.length === 1) {
          emit({ type: "tool_call_start", id: daemonCallId, name: "lookup" });
          emit({ type: "tool_call_delta", arguments: "{}" });
          emit({ type: "tool_call_end" });
          emit({ type: "done", stopReason: "tool_use", endTurn: false });
        } else {
          emit({ type: "text_delta", text: "rewritten-id-done", phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true });
        }
      },
    }),
  });
  const url = `http://127.0.0.1:${server.port}/v1/responses`;
  const tools = [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }];
  const send = async (input: unknown) => {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-low", tools, input, stream: false }),
    });
    expect(response.status).toBe(200);
    return await response.json() as {
      output: Array<{ type: string; call_id?: string; id?: string }>;
    };
  };
  try {
    const prompt = `Stateless client rewrites call ids pi-style ${daemonCallId}`;
    const first = await send(prompt);
    const call = first.output.find(item => item.type === "function_call");
    expect(call?.call_id).toBe(daemonCallId);
    expect(typeof call?.id).toBe("string");
    // pi preserves the bridge item id but rewrites call_id to its own internal id.
    await send([
      { role: "user", content: [{ type: "input_text", text: prompt }] },
      { type: "function_call", call_id: rewrittenCallId, id: call!.id, name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: rewrittenCallId, output: "rewritten=7" },
    ]);
    expect(seen[1]!.threadId).toBe(seen[0]!.threadId);
    expect(seen[1]!.turnId).toBe(seen[0]!.turnId);
    expect(seen[1]!.execution).toBe(seen[0]!.execution);
    expect(seen[1]!.messages).toContain("rewritten=7");
    expect(seen[1]!.messages).not.toContain("Continue using the tool result above.");
  } finally {
    await server.stop(true);
  }
});

test("stateless custom tool transcript resumes the same browser execution", async () => {
  const config = { ...defaultConfig("full"), port: 0, solAvailable: true };
  // Fresh ids per run: stale states from earlier runs must never match ambiguously.
  const suffix = randomUUID().slice(0, 8);
  const callId = `call_custom_stateless_1_${suffix}`;
  const prompt = `Run the custom exec tool ${suffix}`;
  const seen: Array<{ threadId?: string; turnId?: string; execution: string; round: string; messages: string }> = [];
  const server = startServer(config, {
    adapterFactory: () => ({
      name: "generic-stateless-custom-tool-test",
      async runTurn(parsed, _incoming, emit) {
        seen.push({
          ...extractChatGptTurnIdentity(parsed),
          execution: chatGptTurnExecutionKey(parsed),
          round: chatGptTurnRoundKey(parsed),
          messages: JSON.stringify(parsed.context.messages),
        });
        if (seen.length === 1) {
          emit({ type: "tool_call_start", id: callId, name: "exec" });
          emit({ type: "tool_call_delta", arguments: '{"input":"text(42)"}' });
          emit({ type: "tool_call_end" });
          emit({ type: "done", stopReason: "tool_use", endTurn: false });
        } else {
          emit({ type: "text_delta", text: "custom-tool-done", phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true });
        }
      },
    }),
  });
  const url = `http://127.0.0.1:${server.port}/v1/responses`;
  const tools = [{ type: "custom", name: "exec", format: { type: "text" } }];
  const send = async (input: unknown) => {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-low", tools, input, stream: false }),
    });
    expect(response.status).toBe(200);
    return await response.json() as { output: Array<{ type: string; call_id?: string; input?: string }> };
  };
  try {
    const first = await send(prompt);
    expect(first.output).toContainEqual(expect.objectContaining({
      type: "custom_tool_call", call_id: callId, input: "text(42)",
    }));
    await send([
      { role: "user", content: [{ type: "input_text", text: prompt }] },
      { type: "custom_tool_call", call_id: callId, name: "exec", input: "text(42)" },
      { type: "custom_tool_call_output", call_id: callId, output: "42" },
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.threadId).toBe(seen[0]!.threadId);
    expect(seen[1]!.turnId).toBe(seen[0]!.turnId);
    expect(seen[1]!.execution).toBe(seen[0]!.execution);
    expect(seen[1]!.round).not.toBe(seen[0]!.round);
    expect(seen[1]!.messages).toContain("42");
    expect(seen[1]!.messages).not.toContain("Continue using the tool result above.");
  } finally {
    await server.stop(true);
  }
});

test("Chat Completions converts Jcode-style function tools to Responses and back", async () => {
  const config = { ...defaultConfig("full"), port: 0, solAvailable: true };
  const server = startServer(config, {
    adapterFactory: () => ({
      name: "chat-completions-tool-test",
      async runTurn(parsed, _incoming, emit) {
        expect(parsed._genericOpenAiCompatible).toBe(true);
        expect(parsed.context.tools?.map(tool => tool.name)).toEqual(["lookup"]);
        emit({ type: "tool_call_start", id: "call_jcode_lookup_1", name: "lookup" });
        emit({ type: "tool_call_delta", arguments: "{\"key\":\"example\"}" });
        emit({ type: "tool_call_end" });
        emit({ type: "done", stopReason: "tool_use", endTurn: false });
      },
    }),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-low",
        messages: [{ role: "user", content: "Look up a value" }],
        tools: [{ type: "function", function: { name: "lookup", description: "Look up", parameters: { type: "object", properties: {} } } }],
      }),
    });
    expect(response.status).toBe(200);
    const data = await response.json() as { object: string; choices: Array<{
      finish_reason: string;
      message: { role: string; tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
    }> };
    expect(data.object).toBe("chat.completion");
    expect(data.choices[0]!.finish_reason).toBe("tool_calls");
    expect(data.choices[0]!.message.tool_calls[0]).toEqual({
      id: "call_jcode_lookup_1", type: "function",
      function: { name: "lookup", arguments: "{\"key\":\"example\"}" },
    });
  } finally {
    await server.stop(true);
  }
});

test("Chat Completions SSE accepts CRLF and CR boundaries split across chunks", async () => {
  const encoder = new TextEncoder();
  const response = { id: "resp_crlf", model: "chatgpt-low", status: "completed", usage: { input_tokens: 2, output_tokens: 3 } };
  const frames = [
    `event: response.created\r\ndata: ${JSON.stringify({ response })}\r\n\r\n`,
    `event: response.output_text.delta\rdata: ${JSON.stringify({ delta: "sse-ok" })}\r\r`,
    `event: response.completed\r\ndata: ${JSON.stringify({ response })}\r\n\r\n`,
  ].join("");
  // Deliberately terminate chunks between CR and LF and between two CR boundaries.
  const parts = frames.split(/(?<=\r)(?=\n)|(?<=\r)(?=\r)/);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  const result = await new Response(asChatCompletionSSE(source, "fallback", true)).text();
  expect(result).toContain('"id":"chatcmpl_resp_crlf"');
  expect(result).toContain('"content":"sse-ok"');
  expect(result).toContain('"finish_reason":"stop"');
  expect(result).toContain('"prompt_tokens":2');
  expect(result).toContain("data: [DONE]");
});

test("Chat Completions streams text, tool arguments, usage and [DONE]", async () => {
  const config = { ...defaultConfig("full"), port: 0, solAvailable: true };
  let turns = 0;
  const server = startServer(config, {
    adapterFactory: () => ({
      name: "chat-completions-sse-test",
      async runTurn(_parsed, _incoming, emit) {
        turns++;
        if (turns === 1) {
          emit({ type: "text_delta", text: "hello", phase: "final_answer" });
          emit({ type: "text_delta", text: " world", phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true });
        } else {
          emit({ type: "tool_call_start", id: "call_jcode_stream_2", name: "lookup" });
          emit({ type: "tool_call_delta", arguments: "{\"key\":" });
          emit({ type: "tool_call_delta", arguments: "\"value\"}" });
          emit({ type: "tool_call_end" });
          emit({ type: "done", stopReason: "tool_use", endTurn: false });
        }
      },
    }),
  });
  try {
    const url = `http://127.0.0.1:${server.port}/v1/chat/completions`;
    const first = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-low", stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "Say hello" }],
      }),
    });
    expect(first.status).toBe(200);
    const chunks = await first.text();
    expect(chunks).toContain('"delta":{"role":"assistant"}');
    expect(chunks).toContain('"content":"hello"');
    expect(chunks).toContain('"content":" world"');
    expect(chunks).toContain('"finish_reason":"stop"');
    expect(chunks).toContain('"choices":[],"usage":');
    expect(chunks).toContain("data: [DONE]");

    const second = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-low", stream: true,
        messages: [{ role: "user", content: "Use the lookup function" }],
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      }),
    });
    expect(second.status).toBe(200);
    const tools = await second.text();
    expect(tools).toContain('"id":"call_jcode_stream_2"');
    expect(tools).toContain('"arguments":"{\\"key\\":"');
    expect(tools).toContain('"finish_reason":"tool_calls"');
    expect(tools).toContain("data: [DONE]");
  } finally {
    await server.stop(true);
  }
});

test("Jcode-style full-history tool results retain their pending browser execution", async () => {
  const config = { ...defaultConfig("full"), port: 0, solAvailable: true };
  // Fresh ids per run: stale states from earlier runs must never match ambiguously.
  const suffix = randomUUID().slice(0, 8);
  const callId = `call_jcode_continuation_3_${suffix}`;
  const prompt = `Jcode continuation probe ${suffix}`;
  const seen: Array<{ threadId?: string; turnId?: string; execution: string; messages: string }> = [];
  const server = startServer(config, {
    adapterFactory: () => ({
      name: "chat-completions-tool-continuation",
      async runTurn(parsed, _incoming, emit) {
        seen.push({
          ...extractChatGptTurnIdentity(parsed),
          execution: chatGptTurnExecutionKey(parsed),
          messages: JSON.stringify(parsed.context.messages),
        });
        if (seen.length === 1) {
          emit({ type: "tool_call_start", id: callId, name: "lookup" });
          emit({ type: "tool_call_delta", arguments: "{}" });
          emit({ type: "tool_call_end" });
          emit({ type: "done", stopReason: "tool_use", endTurn: false });
        } else {
          emit({ type: "text_delta", text: "result=42", phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true });
        }
      },
    }),
  });
  const url = `http://127.0.0.1:${server.port}/v1/chat/completions`;
  const tool = { type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } };
  try {
    const first = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-low", tools: [tool], messages: [{ role: "user", content: prompt }] }),
    });
    expect(first.status).toBe(200);
    const result = await first.json() as { choices: Array<{ message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> };
    const call = result.choices[0]!.message.tool_calls![0]!;
    const second = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-low", tools: [tool],
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: null, tool_calls: [{ type: "function", id: call.id, function: call.function }] },
          { role: "tool", tool_call_id: call.id, content: "lookup returned 42" },
        ],
      }),
    });
    expect(second.status).toBe(200);
    expect(JSON.stringify(await second.json())).toContain("result=42");
    expect(seen[1]!.threadId).toBe(seen[0]!.threadId);
    expect(seen[1]!.turnId).toBe(seen[0]!.turnId);
    expect(seen[1]!.execution).toBe(seen[0]!.execution);
    expect(seen[1]!.messages).toContain("lookup returned 42");
  } finally {
    await server.stop(true);
  }
});

test("Chat Completions rejects unsupported choices and models before opening a browser", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0, solAvailable: true };
  const server = startServer(config, {
    adapterFactory: () => { throw new Error("must not open browser"); },
  });
  try {
    const url = `http://127.0.0.1:${server.port}/v1/chat/completions`;
    const send = async (data: Record<string, unknown>) => fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-low", messages: [{ role: "user", content: "ping" }], ...data }),
    });
    expect((await send({ n: 2 })).status).toBe(400);
    expect((await send({ response_format: { type: "unknown" } })).status).toBe(400);
    expect((await send({ response_format: { type: "json_schema" } })).status).toBe(400);
    expect((await send({ model: "not-a-routed-web-model" })).status).toBe(404);
    expect((await send({ messages: [{ role: "function", name: "lookup", content: "{}" }] })).status).toBe(400);
  } finally {
    await server.stop(true);
  }
});

test("Chat Completions JSON object mode reaches the enforced browser output schema", async () => {
  const server = startServer({ ...defaultConfig("browser-only"), port: 0, solAvailable: true }, {
    adapterFactory: () => ({
      name: "json-object-test",
      async runTurn(parsed, _incoming, emit) {
        const validate = createChatGptStructuredOutputValidator(parsed.options.outputFormat);
        expect(validate).toBeDefined();
        expect(() => validate!("prose")).toThrow();
        expect(() => validate!("[]")).toThrow();
        validate!('{"ok":true}');
        emit({ type: "text_delta", text: '{"ok":true}', phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    }),
  });
  try {
    for (const stream of [false, true]) {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "chatgpt-low", messages: [{ role: "user", content: "Return JSON" }], response_format: { type: "json_object" }, stream }),
      });
      expect(response.status).toBe(200);
      if (stream) expect(await response.text()).toContain("data: [DONE]");
      else expect(JSON.parse((await response.json()).choices[0].message.content)).toEqual({ ok: true });
    }
  } finally {
    await server.stop(true);
  }
});

test("Chat Completions rejects a stream whose final tool arguments contradict its deltas", async () => {
  const encoder = new TextEncoder();
  const events = [
    ["response.output_item.added", { item: { type: "function_call", id: "fc_bad", call_id: "call_bad", name: "lookup" } }],
    ["response.function_call_arguments.delta", { item_id: "fc_bad", delta: '{"a":1}' }],
    ["response.function_call_arguments.done", { item_id: "fc_bad", arguments: '{"a":2}' }],
    ["response.completed", { response: { status: "completed" } }],
  ];
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const [event, data] of events) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      controller.close();
    },
  });
  await expect(new Response(asChatCompletionSSE(source, "chatgpt-low", false)).text()).rejects.toThrow("Final tool arguments disagree");
});
