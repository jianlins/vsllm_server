// VSLLM Server: Expose VSCode chat models via OpenAI-compatible API with lifecycle control

import * as vscode from "vscode";
import * as http from "http";
import * as crypto from "crypto";
import { IncomingMessage, ServerResponse } from "http";
import { monitor, TrafficRecord } from "./monitor";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8801;
const DEFAULT_MAX_REQUEST_BYTES = 1048576;
const MODEL_SELECTION_TIMEOUT_MS = 10000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Error carrying the HTTP status and OpenAI error shape to report to the client. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type: string = "invalid_request_error",
    readonly code?: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

interface RequestConfig {
  apiKey: string;
  allowedOrigins: string[];
  maxRequestBytes: number;
  modelId: string;
}

function readRequestConfig(): RequestConfig {
  const config = vscode.workspace.getConfiguration("vsllmServer");
  const maxRequestBytes = config.get<number>("maxRequestBytes", DEFAULT_MAX_REQUEST_BYTES);
  return {
    apiKey: config.get<string>("apiKey", "").trim(),
    allowedOrigins: config.get<string[]>("allowedOrigins", []) ?? [],
    maxRequestBytes:
      Number.isFinite(maxRequestBytes) && maxRequestBytes > 0 ? maxRequestBytes : DEFAULT_MAX_REQUEST_BYTES,
    modelId: config.get<string>("model", "").trim(),
  };
}

/**
 * CORS is opt-in: with no configured origins the server emits no CORS headers at all, so a
 * random web page cannot read responses from the local server.
 */
function corsHeadersFor(req: IncomingMessage, cfg: RequestConfig): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin || cfg.allowedOrigins.length === 0) {
    return {};
  }
  const allowAll = cfg.allowedOrigins.includes("*");
  if (!allowAll && !cfg.allowedOrigins.includes(origin)) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": allowAll ? "*" : origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  };
}

function timingSafeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

/** Enforces `vsllmServer.apiKey` when one is configured; a blank key keeps the server open. */
function assertAuthorized(req: IncomingMessage, cfg: RequestConfig): void {
  if (!cfg.apiKey) {
    return;
  }
  const header = req.headers.authorization ?? "";
  const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : header.trim();
  if (!presented || !timingSafeEquals(presented, cfg.apiKey)) {
    throw new HttpError(
      401,
      "Missing or invalid API key. Send it as an 'Authorization: Bearer <key>' header.",
      "invalid_request_error",
      "invalid_api_key"
    );
  }
}

type OpenAIContent = string | Array<{ type: string; text?: string; image_url?: any }> | null | undefined;

interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIMessage {
  role?: string;
  content?: OpenAIContent;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAITool {
  type?: string;
  function?: { name?: string; description?: string; parameters?: object };
}

interface StreamPart {
  kind: "text" | "tool-call";
  text?: string;
  callId?: string;
  name?: string;
  input?: object;
}

/** VS Code only accepts tool names matching a restricted character set. */
function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function extractTextContent(content: OpenAIContent): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    // Reject rather than silently drop: dropping an image leaves the model answering about nothing.
    const unsupported = content.filter(
      (part) => part && part.type !== "text" && part.type !== "input_text"
    );
    if (unsupported.length > 0) {
      const kinds = [...new Set(unsupported.map((p) => String(p.type)))].join(", ");
      throw new HttpError(
        400,
        `Unsupported message content part(s): ${kinds}. The VS Code Language Model API only accepts text.`,
        "invalid_request_error",
        "unsupported_content_part"
      );
    }
    return content
      .filter((part) => part && part.text)
      .map((part) => part.text)
      .join("\n");
  }
  if (content === null || content === undefined) {
    return "";
  }
  return String(content);
}

function safeParseJson(text: string | undefined): object {
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : { value: parsed };
  } catch {
    return { value: text };
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

class VsCodeLmHandler {
  async listModels(): Promise<vscode.LanguageModelChat[]> {
    if (!("lm" in vscode) || !vscode.lm?.selectChatModels) {
      throw new HttpError(
        503,
        "The VS Code Language Model API is not available in this environment.",
        "server_error",
        "model_unavailable"
      );
    }
    // Always clear the timer, otherwise every request leaks a 10s handle.
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        vscode.lm.selectChatModels({ vendor: "copilot" }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new HttpError(504, "Timed out selecting a VS Code chat model.", "server_error")),
            MODEL_SELECTION_TIMEOUT_MS
          );
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Resolves the model to use for a request. The extension's configured model always wins;
   * any `model` field sent by the client is ignored so clients can't switch models by asking
   * for a different (even valid) name.
   */
  async getClient(cfg: RequestConfig): Promise<vscode.LanguageModelChat> {
    const models = await this.listModels();
    if (models.length === 0) {
      throw new HttpError(503, "No VS Code chat models are available.", "server_error", "model_unavailable");
    }

    if (cfg.modelId) {
      const configured = models.find((m) => m.id === cfg.modelId) ?? models.find((m) => m.family === cfg.modelId);
      if (configured) {
        return configured;
      }
    }
    return models[0];
  }

  /**
   * Translate an OpenAI message array into VS Code chat messages, preserving assistant tool
   * calls and tool results so multi-turn agent clients (opencode, Cline, ...) keep working.
   */
  convertMessages(
    messages: OpenAIMessage[],
    toolNameMap: Map<string, string>,
    record?: TrafficRecord
  ): vscode.LanguageModelChatMessage[] {
    const converted: vscode.LanguageModelChatMessage[] = [];
    let dropped = 0;

    for (const msg of messages) {
      const role = (msg.role || "user").toLowerCase();
      const text = extractTextContent(msg.content);

      if (role === "tool" || role === "function") {
        const callId = msg.tool_call_id || msg.name || "unknown_call";
        converted.push(
          vscode.LanguageModelChatMessage.User([
            new vscode.LanguageModelToolResultPart(callId, [
              new vscode.LanguageModelTextPart(text || "(empty tool result)"),
            ]),
          ])
        );
        continue;
      }

      if (role === "assistant") {
        const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
        if (text.trim()) {
          parts.push(new vscode.LanguageModelTextPart(text));
        }
        for (const call of msg.tool_calls || []) {
          const rawName = call.function?.name || "";
          if (!rawName) {
            continue;
          }
          const safeName = sanitizeToolName(rawName);
          toolNameMap.set(safeName, rawName);
          parts.push(
            new vscode.LanguageModelToolCallPart(
              call.id || `call_${safeName}`,
              safeName,
              safeParseJson(call.function?.arguments)
            )
          );
        }
        if (parts.length === 0) {
          dropped++;
          continue;
        }
        converted.push(vscode.LanguageModelChatMessage.Assistant(parts));
        continue;
      }

      // system / developer / user all map onto a user message.
      if (!text.trim()) {
        dropped++;
        continue;
      }
      converted.push(vscode.LanguageModelChatMessage.User(text));
    }

    if (dropped > 0 && record) {
      monitor.warn(record, `${dropped} message(s) had no usable content and were dropped before calling the model.`);
    }
    return converted;
  }

  convertTools(tools: OpenAITool[], toolNameMap: Map<string, string>): vscode.LanguageModelChatTool[] {
    const result: vscode.LanguageModelChatTool[] = [];
    for (const tool of tools) {
      const fn = tool.function;
      if (!fn?.name) {
        continue;
      }
      const safeName = sanitizeToolName(fn.name);
      toolNameMap.set(safeName, fn.name);
      result.push({
        name: safeName,
        description: fn.description || fn.name,
        inputSchema: fn.parameters ?? { type: "object", properties: {} },
      });
    }
    return result;
  }

  async *streamChat(
    messages: OpenAIMessage[],
    tools: OpenAITool[],
    toolChoice: unknown,
    cfg: RequestConfig,
    record: TrafficRecord,
    token: vscode.CancellationToken
  ): AsyncGenerator<StreamPart, void, unknown> {
    const config = vscode.workspace.getConfiguration("vsllmServer");
    const toolsEnabled = config.get<boolean>("enableToolCalling", true);

    const client = await this.getClient(cfg);
    monitor.setResolvedModel(record, `${client.id} (${client.vendor}/${client.family}, max in ${client.maxInputTokens})`);

    const toolNameMap = new Map<string, string>();
    const vsMessages = this.convertMessages(messages, toolNameMap, record);
    if (vsMessages.length === 0) {
      throw new HttpError(400, "Request contained no usable messages.");
    }

    const options: vscode.LanguageModelChatRequestOptions = {
      justification: "VSLLM Server is forwarding an OpenAI-compatible API request.",
    };

    if (tools.length > 0) {
      if (!toolsEnabled) {
        monitor.warn(
          record,
          `Client offered ${tools.length} tool(s) but "vsllmServer.enableToolCalling" is disabled. ` +
            "The model cannot call tools, so agent clients stop after the first text reply."
        );
      } else {
        const converted = this.convertTools(tools, toolNameMap);
        options.tools = converted;
        const choice = typeof toolChoice === "string" ? toolChoice : (toolChoice as any)?.type;
        if (choice === "none") {
          delete options.tools;
          monitor.event(record, "tools", "tool_choice=none, tools withheld from the model");
        } else if ((choice === "required" || choice === "any" || (toolChoice as any)?.function) && converted.length === 1) {
          options.toolMode = vscode.LanguageModelChatToolMode.Required;
        } else {
          options.toolMode = vscode.LanguageModelChatToolMode.Auto;
          if (choice === "required" || choice === "any") {
            monitor.warn(record, "tool_choice=required is only supported with a single tool; falling back to auto.");
          }
        }
        if (options.tools) {
          monitor.event(record, "tools", `forwarded ${options.tools.length} tool(s) to the model`);
        }
      }
    }

    const response = await client.sendRequest(vsMessages, options, token);
    for await (const chunk of response.stream) {
      if (chunk instanceof vscode.LanguageModelTextPart) {
        yield { kind: "text", text: chunk.value };
      } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
        yield {
          kind: "tool-call",
          callId: chunk.callId,
          name: toolNameMap.get(chunk.name) || chunk.name,
          input: chunk.input ?? {},
        };
      }
    }
  }
}

const handler = new VsCodeLmHandler();

function writeAndCount(res: ServerResponse, record: TrafficRecord, payload: string) {
  monitor.addBytesOut(record, Buffer.byteLength(payload, "utf8"));
  res.write(payload);
}

function endJson(res: ServerResponse, record: TrafficRecord, status: number, body: unknown, headers: object) {
  const payload = JSON.stringify(body);
  monitor.addBytesOut(record, Buffer.byteLength(payload, "utf8"));
  monitor.setResponseBody(record, payload);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(payload);
}

function normalizePath(rawUrl: string | undefined): { path: string; query: string } {
  const raw = rawUrl || "/";
  const queryIndex = raw.indexOf("?");
  const query = queryIndex >= 0 ? raw.slice(queryIndex) : "";
  let path = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  return { path, query };
}

function collectHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    headers[key] = key.toLowerCase() === "authorization" ? text.slice(0, 12) + "\u2026(redacted)" : text;
  }
  return headers;
}

async function listModelsPayload(
  cfg: RequestConfig
): Promise<Array<{ id: string; object: string; created: number; owned_by: string }>> {
  const created = Math.floor(Date.now() / 1000);
  const models = await handler.listModels();
  if (models.length > 0) {
    return models.map((m) => ({ id: m.id, object: "model", created, owned_by: m.vendor || "vsllm-server" }));
  }
  return [{ id: cfg.modelId || "vsllm-copilot", object: "model", created, owned_by: "vsllm-server" }];
}

/** Reads the body, refusing anything over the configured cap so a client cannot exhaust memory. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      fn();
    };

    function onData(chunk: Buffer) {
      total += chunk.length;
      if (total > maxBytes) {
        req.pause();
        finish(() =>
          reject(
            new HttpError(
              413,
              `Request body exceeds the ${maxBytes} byte limit (see vsllmServer.maxRequestBytes).`,
              "invalid_request_error",
              "payload_too_large"
            )
          )
        );
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      finish(() => resolve(Buffer.concat(chunks).toString("utf8")));
    }
    function onError(err: Error) {
      finish(() => reject(new HttpError(499, err.message, "server_error")));
    }

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function errorPayload(err: unknown) {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: { message: err.message, type: err.type, code: err.code } } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: { message, type: "server_error" } } };
}

async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  record: TrafficRecord,
  cfg: RequestConfig,
  corsHeaders: Record<string, string>
) {
  req.on("aborted", () => {
    monitor.event(record, "aborted", "client closed the connection before the response finished");
  });

  const cancellation = new vscode.CancellationTokenSource();
  res.on("close", () => {
    if (record.state === "active") {
      cancellation.cancel();
    }
  });

  const streamId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let isStreaming = false;
  let text = "";
  const toolCalls: Array<{ id: string; name: string; input: object }> = [];

  try {
    const body = await readBody(req, cfg.maxRequestBytes);
    monitor.setRequestBody(record, body);
    if (!body.trim()) {
      throw new HttpError(400, "Request body is empty; expected a JSON object.");
    }

    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch (parseErr) {
      throw new HttpError(
        400,
        `Invalid JSON body: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
      );
    }

    const messages: OpenAIMessage[] = Array.isArray(payload.messages) ? payload.messages : [];
    const tools: OpenAITool[] = Array.isArray(payload.tools) ? payload.tools : [];
    isStreaming = payload.stream === true;
    // Report the extension's configured model name, not whatever the client asked for —
    // the client's requested model is ignored entirely (see VsCodeLmHandler.getClient).
    const modelName = cfg.modelId || "vsllm-copilot";

    if (messages.length === 0) {
      throw new HttpError(
        400,
        "Request must include a non-empty 'messages' array.",
        "invalid_request_error",
        "missing_messages"
      );
    }

    monitor.describePayload(record, {
      stream: isStreaming,
      modelRequested: payload.model,
      messages,
      toolNames: tools.map((t) => t.function?.name || "(unnamed)"),
      toolChoice: payload.tool_choice ? JSON.stringify(payload.tool_choice) : undefined,
      promptChars: messages.reduce((sum, m) => {
        try {
          return sum + extractTextContent(m.content).length;
        } catch {
          return sum;
        }
      }, 0),
    });

    if (isStreaming) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders,
      });
      writeAndCount(
        res,
        record,
        `data: ${JSON.stringify({
          id: streamId,
          object: "chat.completion.chunk",
          created,
          model: modelName,
          choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
        })}\n\n`
      );
    }

    for await (const part of handler.streamChat(
      messages,
      tools,
      payload.tool_choice,
      cfg,
      record,
      cancellation.token
    )) {
      if (part.kind === "text" && part.text) {
        text += part.text;
        monitor.appendText(record, part.text);
        if (isStreaming) {
          writeAndCount(
            res,
            record,
            `data: ${JSON.stringify({
              id: streamId,
              object: "chat.completion.chunk",
              created,
              model: modelName,
              choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }],
            })}\n\n`
          );
        }
      } else if (part.kind === "tool-call") {
        const call = {
          id: part.callId || `call_${toolCalls.length}`,
          name: part.name || "unknown",
          input: part.input ?? {},
        };
        toolCalls.push(call);
        const args = JSON.stringify(call.input);
        monitor.addToolCall(record, { id: call.id, name: call.name, args });
        if (isStreaming) {
          writeAndCount(
            res,
            record,
            `data: ${JSON.stringify({
              id: streamId,
              object: "chat.completion.chunk",
              created,
              model: modelName,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: toolCalls.length - 1,
                        id: call.id,
                        type: "function",
                        function: { name: call.name, arguments: args },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            })}\n\n`
          );
        }
      }
    }

    const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
    if (!text.trim() && toolCalls.length === 0) {
      monitor.warn(
        record,
        "The model returned an empty response (no text, no tool calls). Agent clients treat this as the end of the turn."
      );
    }
    if (tools.length > 0 && toolCalls.length === 0) {
      monitor.event(record, "note", `client offered ${tools.length} tool(s); model answered with text only`);
    }

    const promptTokens = estimateTokens(
      messages
        .map((m) => {
          try {
            return extractTextContent(m.content);
          } catch {
            return "";
          }
        })
        .join("\n")
    );
    const completionTokens = estimateTokens(text);
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };

    if (isStreaming) {
      writeAndCount(
        res,
        record,
        `data: ${JSON.stringify({
          id: streamId,
          object: "chat.completion.chunk",
          created,
          model: modelName,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          usage,
        })}\n\n`
      );
      writeAndCount(res, record, "data: [DONE]\n\n");
      res.end();
    } else {
      const message: Record<string, unknown> = { role: "assistant", content: text.length > 0 ? text : null };
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        }));
      }
      endJson(
        res,
        record,
        200,
        {
          id: streamId,
          object: "chat.completion",
          created,
          model: modelName,
          choices: [{ index: 0, message, finish_reason: finishReason }],
          usage,
        },
        corsHeaders
      );
    }
    monitor.finish(record, 200, finishReason);
  } catch (err) {
    const { status, body } = errorPayload(err);
    if (res.writableEnded) {
      monitor.fail(record, err, status);
    } else if (res.headersSent) {
      // Mid-stream failure: the status is already sent, so report through the SSE channel.
      writeAndCount(res, record, `data: ${JSON.stringify(body)}\n\n`);
      writeAndCount(res, record, "data: [DONE]\n\n");
      res.end();
      monitor.fail(record, err, status);
    } else {
      endJson(res, record, status, body, corsHeaders);
      monitor.fail(record, err, status);
    }
  } finally {
    cancellation.dispose();
  }
}

export async function startVsllmServer(
  context: vscode.ExtensionContext,
  opts: { url?: string; port?: number; host?: string } = {}
) {
  const rootConfig = vscode.workspace.getConfiguration("vsllmServer");
  const port = opts.port ?? rootConfig.get<number>("port", DEFAULT_PORT);
  const host = (opts.host ?? rootConfig.get<string>("host", DEFAULT_HOST)).trim() || DEFAULT_HOST;
  const url = opts.url ?? rootConfig.get<string>("url", "http://localhost");

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const { path, query } = normalizePath(req.url);
    const record = monitor.begin({
      method: req.method || "GET",
      path,
      query,
      remote: req.socket.remoteAddress || "unknown",
      headers: collectHeaders(req),
    });

    const cfg = readRequestConfig();
    const corsHeaders = corsHeadersFor(req, cfg);

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      monitor.finish(record, 204);
      return;
    }

    try {
      assertAuthorized(req, cfg);
    } catch (err) {
      const { status, body } = errorPayload(err);
      monitor.warn(record, "Rejected an unauthenticated request (vsllmServer.apiKey is set).");
      endJson(res, record, status, body, corsHeaders);
      monitor.finish(record, status);
      return;
    }

    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      try {
        const data = await listModelsPayload(cfg);
        endJson(res, record, 200, { object: "list", data }, corsHeaders);
        monitor.finish(record, 200);
      } catch (err) {
        const { status, body } = errorPayload(err);
        endJson(res, record, status, body, corsHeaders);
        monitor.fail(record, err, status);
      }
      return;
    }

    if (req.method === "GET" && (path === "/" || path === "/health" || path === "/v1")) {
      endJson(
        res,
        record,
        200,
        { status: "ok", server: "vsllm-server", endpoints: ["/v1/models", "/v1/chat/completions"] },
        corsHeaders
      );
      monitor.finish(record, 200);
      return;
    }

    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      await handleChatCompletions(req, res, record, cfg, corsHeaders);
      return;
    }

    monitor.warn(
      record,
      `Unknown route ${req.method} ${path}. Expected /v1/chat/completions or /v1/models \u2014 check the base URL configured in your client.`
    );
    endJson(res, record, 404, { error: { message: "Not found", type: "invalid_request_error" } }, corsHeaders);
    monitor.finish(record, 404);
  });

  return new Promise<http.Server>((resolve, reject) => {
    const onStartupError = (err: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      const detail =
        err.code === "EADDRINUSE"
          ? `Port ${port} on ${host} is already in use.`
          : err.code === "EACCES"
            ? `Permission denied binding ${host}:${port}.`
            : err.message;
      const message = `VSLLM Server failed to start: ${detail}`;
      monitor.setServerState({ running: false, url, port, phase: "error", detail });
      vscode.window.showErrorMessage(message);
      reject(new Error(message));
    };

    const onListening = () => {
      server.off("error", onStartupError);
      // Runtime errors after startup must not crash the extension host.
      server.on("error", (err) => {
        vscode.window.showErrorMessage(`VSLLM Server error: ${err.message}`);
      });

      context.subscriptions.push({
        dispose: () => {
          server.close();
          monitor.setServerState({ running: false, phase: "stopped", detail: undefined });
        },
      });

      // The caller verifies the endpoint before the light turns green, so stay amber for now.
      monitor.setServerState({ running: true, url, port, startedAt: Date.now(), phase: "starting", detail: undefined });
      vscode.window.showInformationMessage(`VSLLM Server running on ${url}:${port}/v1/chat/completions`);
      if (!LOOPBACK_HOSTS.has(host)) {
        vscode.window.showWarningMessage(
          `VSLLM Server is bound to ${host}, so it is reachable from other machines on your network. ` +
            `Set an API key in vsllmServer.apiKey, or set vsllmServer.host back to 127.0.0.1.`
        );
      }
      resolve(server);
    };

    server.once("error", onStartupError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function stopVsllmServer(server: http.Server) {
  return new Promise<void>((resolve) => {
    server.close(() => {
      monitor.setServerState({ running: false, phase: "stopped", detail: undefined });
      resolve();
    });
  });
}
