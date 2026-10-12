import { randomUUID } from "node:crypto";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject : undefined;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a nonempty string`);
  return value;
}

function textContent(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw new Error("Chat message content must be text or content blocks");
  return value.map(part => {
    const block = object(part);
    if (!block || block.type !== "text" || typeof block.text !== "string") {
      throw new Error("This chat message requires text content blocks");
    }
    return block.text;
  }).join("\n");
}

function userContent(value: unknown): string | JsonObject[] {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw new Error("User message must contain text or image blocks");
  return value.map(part => {
    const block = object(part);
    if (block?.type === "text" && typeof block.text === "string") {
      return { type: "input_text", text: block.text };
    }
    if (block?.type === "image_url") {
      const image = object(block.image_url);
      const url = typeof block.image_url === "string" ? block.image_url : image?.url;
      if (typeof url !== "string" || !url) throw new Error("image_url requires a URL");
      return { type: "input_image", image_url: url, ...(typeof image?.detail === "string" ? { detail: image.detail } : {}) };
    }
    throw new Error("Unsupported Chat Completions user content block");
  });
}

/**
 * Compatibility for clients such as Jcode that speak Chat Completions. Convert
 * their conventional tool transcript to the same generic Responses path used
 * by Pi and Hermes. Caller metadata cannot impersonate a native Codex turn.
 */
export function prepareChatCompletionAsResponses(value: unknown): JsonObject {
  const body = object(value);
  if (!body) throw new Error("Chat Completions body must be a JSON object");
  const model = requiredString(body.model, "model");
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error("messages must be a nonempty array");
  }
  if (body.n !== undefined && body.n !== 1) {
    throw new Error("Only one Chat Completions choice is supported");
  }
  const input: JsonObject[] = [];
  for (const value of body.messages) {
    const message = object(value);
    if (!message) throw new Error("messages entries must be objects");
    if (message.role === "user") {
      input.push({ type: "message", role: "user", content: userContent(message.content) });
    } else if (message.role === "system" || message.role === "developer") {
      const content = textContent(message.content);
      if (content === undefined) throw new Error(`${message.role} message must contain text`);
      input.push({ type: "message", role: message.role, content });
    } else if (message.role === "assistant") {
      const content = textContent(message.content);
      if (content) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] });
      if (message.tool_calls !== undefined) {
        if (!Array.isArray(message.tool_calls)) throw new Error("assistant.tool_calls must be an array");
        for (const value of message.tool_calls) {
          const call = object(value);
          const fn = object(call?.function);
          if (call?.type !== "function" || !fn) throw new Error("Only function tool calls are supported");
          input.push({
            type: "function_call",
            call_id: requiredString(call.id, "tool_call.id"),
            name: requiredString(fn.name, "tool_call.function.name"),
            arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
          });
        }
      }
    } else if (message.role === "tool") {
      const content = textContent(message.content);
      input.push({
        type: "function_call_output",
        call_id: requiredString(message.tool_call_id, "tool.tool_call_id"),
        output: content ?? "",
      });
    } else {
      throw new Error(`Unsupported Chat Completions role: ${String(message.role)}`);
    }
  }

  const tools = body.tools === undefined ? undefined : (() => {
    if (!Array.isArray(body.tools)) throw new Error("tools must be an array");
    return body.tools.map(value => {
      const tool = object(value);
      const fn = object(tool?.function);
      if (tool?.type !== "function" || !fn) throw new Error("Only function tools are supported");
      return {
        type: "function",
        name: requiredString(fn.name, "tool.function.name"),
        ...(typeof fn.description === "string" ? { description: fn.description } : {}),
        ...(object(fn.parameters) ? { parameters: fn.parameters } : {}),
        ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
      };
    });
  })();
  let toolChoice = body.tool_choice;
  const selected = object(toolChoice);
  if (selected?.type === "function") {
    toolChoice = { type: "function", name: requiredString(object(selected.function)?.name, "tool_choice.function.name") };
  }
  const format = object(body.response_format);
  if (body.response_format !== undefined && (!format || !["text", "json_object", "json_schema"].includes(String(format.type)))) {
    throw new Error("Unsupported Chat Completions response_format");
  }
  const jsonSchema = format?.type === "json_schema" ? object(format.json_schema) : undefined;
  if (format?.type === "json_schema" && (!jsonSchema || typeof jsonSchema.name !== "string" || !jsonSchema.name || jsonSchema.schema === undefined)) {
    throw new Error("response_format.json_schema requires a name and schema");
  }
  const text = format?.type === "json_object"
    ? { format: { type: "json_schema", name: "json_object", schema: { type: "object" }, strict: true } }
    : jsonSchema && typeof jsonSchema.name === "string" && jsonSchema.schema !== undefined
    ? { format: { type: "json_schema", name: jsonSchema.name, schema: jsonSchema.schema, strict: jsonSchema.strict === true } }
    : undefined;

  return {
    model,
    input,
    stream: body.stream === true,
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(body.parallel_tool_calls !== undefined ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
    ...(body.max_completion_tokens !== undefined || body.max_tokens !== undefined
      ? { max_output_tokens: body.max_completion_tokens ?? body.max_tokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.stop !== undefined ? { stop: body.stop } : {}),
    ...(body.frequency_penalty !== undefined ? { frequency_penalty: body.frequency_penalty } : {}),
    ...(body.presence_penalty !== undefined ? { presence_penalty: body.presence_penalty } : {}),
    ...(typeof body.reasoning_effort === "string" ? { reasoning: { effort: body.reasoning_effort } } : {}),
    ...(text ? { text } : {}),
  };
}

function responseUsage(value: unknown): JsonObject {
  const usage = object(value);
  const prompt = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
  const completion = typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: typeof usage?.total_tokens === "number" ? usage.total_tokens : prompt + completion,
  };
}

export function asChatCompletionResponse(value: unknown): JsonObject {
  const response = object(value);
  if (!response) throw new Error("Responses output must be an object");
  const output = Array.isArray(response.output) ? response.output : [];
  const content: string[] = [];
  const toolCalls: JsonObject[] = [];
  for (const value of output) {
    const item = object(value);
    if (item?.type === "message" && item.role === "assistant" && Array.isArray(item.content)) {
      for (const block of item.content) {
        const text = object(block);
        if (text?.type === "output_text" && typeof text.text === "string") content.push(text.text);
      }
    } else if (item?.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments ?? "{}" },
      });
    }
  }
  return {
    id: typeof response.id === "string" ? `chatcmpl_${response.id}` : `chatcmpl_${randomUUID()}`,
    object: "chat.completion",
    created: typeof response.created_at === "number" ? response.created_at : Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: content.length > 0 ? content.join("") : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length > 0 ? "tool_calls" : response.status === "incomplete" ? "length" : "stop",
    }],
    usage: responseUsage(response.usage),
  };
}

/**
 * Stream Chat Completions chunks while the existing Responses bridge emits
 * incremental SSE. IDs, function-call argument pieces and terminal usage are
 * converted without buffering the full browser answer.
 */
export function asChatCompletionSSE(
  responses: ReadableStream<Uint8Array>,
  fallbackModel: string,
  includeUsage = false,
): ReadableStream<Uint8Array> {
  const reader = responses.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let id = `chatcmpl_${randomUUID()}`;
  let created = Math.floor(Date.now() / 1000);
  let model = fallbackModel;
  let started = false;
  let finished = false;
  let toolCount = 0;
  const toolByItem = new Map<string, { index: number; emitted: string }>();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (value: unknown): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      };
      const chunk = (delta: JsonObject, finishReason: string | null = null): void => {
        write({
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        });
      };
      const role = (): void => {
        if (!started) {
          started = true;
          chunk({ role: "assistant" });
        }
      };
      const toolAdded = (item: JsonObject): void => {
        if (typeof item.id !== "string" || toolByItem.has(item.id) || typeof item.call_id !== "string"
          || typeof item.name !== "string") return;
        role();
        const index = toolCount++;
        toolByItem.set(item.id, { index, emitted: "" });
        chunk({ tool_calls: [{ index, id: item.call_id, type: "function", function: { name: item.name, arguments: "" } }] });
      };
      const toolArguments = (itemId: unknown, args: unknown, complete = false): void => {
        if (typeof itemId !== "string" || typeof args !== "string") return;
        const tool = toolByItem.get(itemId);
        if (!tool) return;
        if (complete && !args.startsWith(tool.emitted)) {
          throw new Error("Final tool arguments disagree with streamed argument deltas");
        }
        const delta = complete ? args.slice(tool.emitted.length) : args;
        if (!delta) return;
        tool.emitted += delta;
        chunk({ tool_calls: [{ index: tool.index, function: { arguments: delta } }] });
      };
      const complete = (reason: string, response?: JsonObject): void => {
        if (finished) return;
        finished = true;
        role();
        chunk({}, reason);
        if (includeUsage) {
          write({ id, object: "chat.completion.chunk", created, model, choices: [], usage: responseUsage(response?.usage) });
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      };
      const metadata = (response: unknown): void => {
        const data = object(response);
        if (!data) return;
        if (typeof data.id === "string") id = `chatcmpl_${data.id}`;
        if (typeof data.created_at === "number") created = data.created_at;
        if (typeof data.model === "string") model = data.model;
      };
      const consume = (frame: string): void => {
        if (finished) return;
        const lines = frame.replaceAll("\r", "").split("\n");
        const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
        const raw = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!raw || raw === "[DONE]") return;
        const data = object(JSON.parse(raw));
        if (!data) return;
        if (event === "response.created") metadata(data.response);
        else if (event === "response.output_text.delta" && typeof data.delta === "string") {
          role();
          chunk({ content: data.delta });
        } else if (event === "response.output_item.added") {
          const item = object(data.item);
          if (item?.type === "function_call") toolAdded(item);
        } else if (event === "response.function_call_arguments.delta") {
          role();
          toolArguments(data.item_id, data.delta);
        } else if (event === "response.function_call_arguments.done") {
          toolArguments(data.item_id, data.arguments, true);
        } else if (event === "response.output_item.done") {
          const item = object(data.item);
          if (item?.type === "function_call") {
            toolAdded(item);
            toolArguments(item.id, item.arguments, true);
          }
        } else if (event === "response.completed" || event === "response.incomplete") {
          metadata(data.response);
          complete(event === "response.incomplete" ? "length" : toolCount > 0 ? "tool_calls" : "stop", object(data.response));
        } else if (event === "response.failed" || event === "error") {
          finished = true;
          write({ error: object(data.response)?.error ?? data.error ?? { message: "Responses stream failed" } });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      };

      void (async () => {
        let buffer = "";
        // SSE permits LF, CRLF and CR line endings. Normalize incrementally so a
        // CRLF pair split across socket reads remains a single line break.
        let pendingCR = false;
        const normalizeLineEndings = (value: string): string => {
          let normalized = "";
          for (const char of value) {
            if (pendingCR) {
              pendingCR = false;
              if (char === "\n") continue;
            }
            if (char === "\r") {
              pendingCR = true;
              normalized += "\n";
            } else {
              normalized += char;
            }
          }
          return normalized;
        };
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          buffer += normalizeLineEndings(decoder.decode(result.value, { stream: true }));
          let separator: number;
          while ((separator = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            consume(frame);
            if (finished) return;
          }
        }
        if (!finished) throw new Error("Responses stream ended without a terminal event");
      })().catch(error => {
        if (!finished) controller.error(error);
      }).finally(() => { void reader.cancel().catch(() => {}); });
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}
