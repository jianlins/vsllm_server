// VSLLM Server: Expose VSCode chat models via OpenAI-compatible API with lifecycle control

import * as vscode from "vscode";
import * as http from "http";
import { IncomingMessage, ServerResponse } from "http";
import { monitor, TrafficRecord } from "./monitor";

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
    return content
      .filter((part) => part && (part.type === "text" || part.type === "input_text") && part.text)
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
  async getClient(): Promise<vscode.LanguageModelChat> {
    const config = vscode.workspace.getConfiguration("vsllmServer");
    const selectedModelId = config.get<string>("model", "");

    const modelsPromise = vscode.lm.selectChatModels({ vendor: "copilot" });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Model selection timeout after 10s")), 10000)
    );

    const models = await Promise.race([modelsPromise, timeoutPromise]);
    let model: vscode.LanguageModelChat | undefined;
    if (selectedModelId) {
      model = models.find((m) => m.id === selectedModelId) ?? models.find((m) => m.family === selectedModelId);
    }
    if (!model && models.length > 0) {
      model = models[0];
    }
    if (!model) {
      throw new Error("No VSCode chat models available.");
    }
    return model;
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
    record: TrafficRecord,
    token: vscode.CancellationToken
  ): AsyncGenerator<StreamPart, void, unknown> {
    const config = vscode.workspace.getConfiguration("vsllmServer");
    const toolsEnabled = config.get<boolean>("enableToolCalling", true);

    const client = await this.getClient();
    monitor.setResolvedModel(record, `${client.id} (${client.vendor}/${client.family}, max in ${client.maxInputTokens})`);

    const toolNameMap = new Map<string, string>();
    const vsMessages = this.convertMessages(messages, toolNameMap, record);
    if (vsMessages.length === 0) {
      throw new Error("Request contained no usable messages.");
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

async function listModels(): Promise<Array<{ id: string; object: string; created: number; owned_by: string }>> {
  const created = Math.floor(Date.now() / 1000);
  try {
    const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    if (models.length > 0) {
      return models.map((m) => ({ id: m.id, object: "model", created, owned_by: m.vendor || "vsllm-server" }));
    }
  } catch {
    // fall through to the configured model
  }
  const configured = vscode.workspace.getConfiguration("vsllmServer").get<string>("model", "");
  return [{ id: configured || "vsllm-copilot", object: "model", created, owned_by: "vsllm-server" }];
}

export async function startVsllmServer(
  context: vscode.ExtensionContext,
  opts: { url?: string; port?: number } = {}
) {
  const port = opts.port ?? 8080;
  const url = opts.url ?? "http://localhost";

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const { path, query } = normalizePath(req.url);
    const record = monitor.begin({
      method: req.method || "GET",
      path,
      query,
      remote: req.socket.remoteAddress || "unknown",
      headers: collectHeaders(req),
    });

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (req.method === "OPTIONS") {
      res.writeHead(200, corsHeaders);
      res.end();
      monitor.finish(record, 200);
      return;
    }

    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      try {
        const data = await listModels();
        endJson(res, record, 200, { object: "list", data }, corsHeaders);
        monitor.finish(record, 200);
      } catch (err) {
        endJson(res, record, 500, { error: err instanceof Error ? err.message : String(err) }, corsHeaders);
        monitor.fail(record, err, 500);
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
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("aborted", () => {
        monitor.event(record, "aborted", "client closed the connection before the response finished");
      });
      req.on("end", async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        monitor.setRequestBody(record, body);

        let payload: any;
        try {
          payload = JSON.parse(body);
        } catch (err) {
          endJson(
            res,
            record,
            400,
            {
              error: {
                message: "Invalid JSON body: " + (err instanceof Error ? err.message : String(err)),
                type: "invalid_request_error",
              },
            },
            corsHeaders
          );
          monitor.fail(record, err, 400);
          return;
        }

        const messages: OpenAIMessage[] = Array.isArray(payload.messages) ? payload.messages : [];
        const tools: OpenAITool[] = Array.isArray(payload.tools) ? payload.tools : [];
        const isStreaming = payload.stream === true;
        const config = vscode.workspace.getConfiguration("vsllmServer");
        const selectedModelId = config.get<string>("model", "");
        const modelName = payload.model || selectedModelId || "vsllm-copilot";

        monitor.describePayload(record, {
          stream: isStreaming,
          modelRequested: payload.model,
          messages,
          toolNames: tools.map((t) => t.function?.name || "(unnamed)"),
          toolChoice: payload.tool_choice ? JSON.stringify(payload.tool_choice) : undefined,
          promptChars: messages.reduce((sum, m) => sum + extractTextContent(m.content).length, 0),
        });

        const cancellation = new vscode.CancellationTokenSource();
        res.on("close", () => {
          if (record.state === "active") {
            cancellation.cancel();
          }
        });

        const streamId = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        let text = "";
        const toolCalls: Array<{ id: string; name: string; input: object }> = [];

        try {
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

          const promptTokens = estimateTokens(messages.map((m) => extractTextContent(m.content)).join("\n"));
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
          const message = err instanceof Error ? err.message : String(err);
          if (isStreaming && res.headersSent) {
            writeAndCount(res, record, `data: ${JSON.stringify({ error: { message, type: "server_error" } })}\n\n`);
            writeAndCount(res, record, "data: [DONE]\n\n");
            res.end();
          } else if (!res.headersSent) {
            endJson(res, record, 500, { error: { message, type: "server_error" } }, corsHeaders);
          } else {
            res.end();
          }
          monitor.fail(record, err, 500);
        } finally {
          cancellation.dispose();
        }
      });
      return;
    }

    monitor.warn(
      record,
      `Unknown route ${req.method} ${path}. Expected /v1/chat/completions or /v1/models \u2014 check the base URL configured in your client.`
    );
    endJson(res, record, 404, { error: "Not found" }, corsHeaders);
    monitor.finish(record, 404);
  });

  server.on("error", (err) => {
    monitor.setServerState({ running: false, url, port });
    vscode.window.showErrorMessage(`VSLLM Server failed on port ${port}: ${err.message}`);
  });

  server.listen(port, () => {
    monitor.setServerState({ running: true, url, port, startedAt: Date.now() });
    vscode.window.showInformationMessage(`VSLLM Server running on ${url}:${port}/v1/chat/completions`);
  });

  context.subscriptions.push({
    dispose: () => {
      server.close();
      monitor.setServerState({ running: false });
    },
  });

  return server;
}

export async function stopVsllmServer(server: http.Server) {
  return new Promise<void>((resolve) => {
    server.close(() => {
      monitor.setServerState({ running: false });
      resolve();
    });
  });
}
