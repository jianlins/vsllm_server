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
    const modelsPromise = vscode.lm.selectChatModels({});
    const timeoutPromise = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error("Model selection timeout after 10s")), 10000)
    );
    
    const models = await Promise.race([modelsPromise, timeoutPromise]);
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

  async chatCompletion(messages: { role: string; content: string }[]): Promise<string> {
    const client = await this.getClient();
    const vsMessages = messages.map((msg) =>
      msg.role === "user"
        ? vscode.LanguageModelChatMessage.User(msg.content)
        : vscode.LanguageModelChatMessage.Assistant(msg.content)
    );
    const response = await client.sendRequest(vsMessages, {}, new vscode.CancellationTokenSource().token);
    let result = "";
    for await (const chunk of response.stream) {
      if (chunk instanceof vscode.LanguageModelTextPart) {
        result += chunk.value;
      }
    }
    return result;
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
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          const messages = payload.messages || [];
          const completion = await handler.chatCompletion(messages);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: "vsllm-chat",
              object: "chat.completion",
              choices: [{ message: { role: "assistant", content: completion } }],
            })
          );
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
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
