// VSLLM Server: Expose VSCode chat models via OpenAI-compatible API with lifecycle control

import * as vscode from "vscode";
import * as http from "http";
import { IncomingMessage, ServerResponse } from "http";

// Minimal VSCode Language Model handler (adapted from Cline)
class VsCodeLmHandler {
  private client: vscode.LanguageModelChat | null = null;
  private clientId: string | null = null;

  async getClient(): Promise<vscode.LanguageModelChat> {
    const config = vscode.workspace.getConfiguration("vsllmServer");
    const selectedModelId = config.get<string>("model", "");
    
    // Add timeout protection for selectChatModels
    const modelsPromise = vscode.lm.selectChatModels({ vendor: "copilot" });
    const timeoutPromise = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error("Model selection timeout after 10s")), 10000)
    );
    
    const models = await Promise.race([modelsPromise, timeoutPromise]);
    // in console, log all available models' name
    console.log("VSLLM Server: Available models", models.map(m => m.name));
    let model: vscode.LanguageModelChat | undefined;
    if (selectedModelId) {
      model = models.find(m => m.id === selectedModelId);
    }
    if (!model && models.length > 0) {
      model = models[0];
    }
    if (!model) {
      throw new Error("No VSCode chat models available.");
    }
    this.client = model;
    this.clientId = model.id;
    return this.client;
  }

  // Helper function to extract text content from various formats
  private extractTextContent(content: string | Array<{type: string; text?: string; image_url?: any}>): string {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      // Extract text from content parts array (OpenAI format)
      return content
        .filter(part => part.type === 'text' && part.text)
        .map(part => part.text)
        .join('\n');
    }
    // Fallback: convert to string
    return String(content);
  }

  private convertMessages(messages: { role: string; content: string | Array<{type: string; text?: string; image_url?: any}> }[]): vscode.LanguageModelChatMessage[] {
    return messages.map((msg) => {
      const textContent = this.extractTextContent(msg.content);
      // Handle system, user, and assistant roles
      if (msg.role === "system" || msg.role === "user") {
        return vscode.LanguageModelChatMessage.User(textContent);
      } else {
        return vscode.LanguageModelChatMessage.Assistant(textContent);
      }
    });
  }

  async chatCompletion(messages: { role: string; content: string | Array<{type: string; text?: string; image_url?: any}> }[]): Promise<string> {
    const client = await this.getClient();
    const vsMessages = this.convertMessages(messages);
    const response = await client.sendRequest(vsMessages, {}, new vscode.CancellationTokenSource().token);
    let result = "";
    for await (const chunk of response.stream) {
      if (chunk instanceof vscode.LanguageModelTextPart) {
        result += chunk.value;
      }
    }
    return result;
  }

  async *chatCompletionStream(messages: { role: string; content: string | Array<{type: string; text?: string; image_url?: any}> }[]): AsyncGenerator<string, void, unknown> {
    const client = await this.getClient();
    const vsMessages = this.convertMessages(messages);
    const response = await client.sendRequest(vsMessages, {}, new vscode.CancellationTokenSource().token);
    for await (const chunk of response.stream) {
      if (chunk instanceof vscode.LanguageModelTextPart) {
        yield chunk.value;
      }
    }
  }
}

const handler = new VsCodeLmHandler();

export async function startVsllmServer(
  context: vscode.ExtensionContext,
  opts: { url?: string; port?: number } = {}
) {
  const port = opts.port ?? 8080;
  const url = opts.url ?? "http://localhost";
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }
    
    // Add CORS headers to all responses
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    // GET /v1/models - List available models
    if (req.method === "GET" && req.url === "/v1/models") {
      try {
        const config = vscode.workspace.getConfiguration("vsllmServer");
        const selectedModelId = config.get<string>("model", "vsllm-copilot");
        res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({
          object: "list",
          data: [{
            id: selectedModelId || "vsllm-copilot",
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "vsllm-server"
          }]
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json", ...corsHeaders });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          const messages = payload.messages || [];
          const config = vscode.workspace.getConfiguration("vsllmServer");
          const selectedModelId = config.get<string>("model", "");
          const isStreaming = payload.stream === true;

          if (isStreaming) {
            // Streaming response (SSE format)
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              ...corsHeaders
            });

            const streamId = `chatcmpl-${Date.now()}`;
            const created = Math.floor(Date.now() / 1000);

            try {
              for await (const chunk of handler.chatCompletionStream(messages)) {
                const data = {
                  id: streamId,
                  object: "chat.completion.chunk",
                  created: created,
                  model: selectedModelId || "vsllm-copilot",
                  choices: [{
                    index: 0,
                    delta: { content: chunk },
                    finish_reason: null
                  }]
                };
                res.write(`data: ${JSON.stringify(data)}\n\n`);
              }

              // Send final chunk with finish_reason
              const finalData = {
                id: streamId,
                object: "chat.completion.chunk",
                created: created,
                model: selectedModelId || "vsllm-copilot",
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: "stop"
                }]
              };
              res.write(`data: ${JSON.stringify(finalData)}\n\n`);
              res.write("data: [DONE]\n\n");
              res.end();
            } catch (streamErr) {
              // If streaming fails mid-way, try to send an error
              const errorData = {
                error: {
                  message: streamErr instanceof Error ? streamErr.message : String(streamErr),
                  type: "server_error"
                }
              };
              res.write(`data: ${JSON.stringify(errorData)}\n\n`);
              res.end();
            }
          } else {
            // Non-streaming response
            const completion = await handler.chatCompletion(messages);
            res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
            res.end(
              JSON.stringify({
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: selectedModelId || "vsllm-copilot",
                choices: [{
                  index: 0,
                  message: { role: "assistant", content: completion },
                  finish_reason: "stop"
                }],
                usage: {
                  prompt_tokens: 0,
                  completion_tokens: 0,
                  total_tokens: 0
                }
              })
            );
          }
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json", ...corsHeaders });
          res.end(JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err), type: "invalid_request_error" } }));
        }
      });
      return;
    }
    
    // 404 for unknown routes
    res.writeHead(404, { "Content-Type": "application/json", ...corsHeaders });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(port, () => {
    vscode.window.showInformationMessage(`VSLLM Server running on ${url}:${port}/v1/chat/completions`);
  });

  context.subscriptions.push({ dispose: () => server.close() });

  return server;
}

export async function stopVsllmServer(server: http.Server) {
  return new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}
