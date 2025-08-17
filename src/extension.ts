import * as vscode from "vscode";
import { startVsllmServer, stopVsllmServer } from "./server";
const fetch = require('node-fetch');

// Helper to always return a usable model (real or fallback)
async function createClient(selector: any): Promise<any> {
  try {
    const models = await vscode.lm.selectChatModels(selector);
    if (models && Array.isArray(models) && models.length > 0) {
      return models[0];
    }
    // Fallback minimal model
    return {
      id: "default-lm",
      name: "Default Language Model",
      vendor: "vscode",
      family: "lm",
      version: "1.0",
      maxInputTokens: 8192,
      sendRequest: async (messages: any, options: any, token: any) => {
        return {
          stream: (async function* () {
            yield "Language model functionality is limited. Please check VS Code configuration.";
          })(),
          text: (async function* () {
            yield "Language model functionality is limited. Please check VS Code configuration.";
          })(),
        };
      },
      countTokens: async () => 0,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`VSLLM <Language Model API>: Failed to select model: ${errorMessage}`);
  }
}
// ...existing code...
// VSLLM Server VSCode extension entrypoint with configuration and lifecycle commands

// ...existing code...

let serverInstance: any = null;
// ...existing code...
// Returns HTML for the configuration Webview

function getConfigWebviewHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  // Get current config values, try reading vsllmServer.json first
  let url = "http://localhost";
  let port = 8081;
  let model = "";
  let apiKey = "";
  let enableLogging = false;
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const wsPath = workspaceFolders[0].uri.fsPath;
      const configFilePath = wsPath + "/vsllmServer.json";
      const fs = require('fs');
      if (fs.existsSync(configFilePath)) {
        const raw = fs.readFileSync(configFilePath, 'utf8');
        try {
          const json = JSON.parse(raw);
          url = json.url || url;
          port = json.port || port;
          model = json.model || model;
          apiKey = json.apiKey || apiKey;
          enableLogging = json.enableLogging || enableLogging;
        } catch (jsonErr) {
          console.error("VSLLM Server: Invalid config file, using defaults.", jsonErr);
        }
      }
    }
  } catch (err) {
    console.error("VSLLM Server: Error reading config file, using defaults.", err);
  }
  // Always show 'listing...' initially, will be replaced asynchronously
  let modelOptions = "<option value=''>Loading models...</option>";
  // Basic HTML/JS/CSS for the config form
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>VSLLM Server Configuration</title>
      <style>
          body { font-family: sans-serif; padding: 20px; }
          h2 { margin-top: 0; }
          label { display: block; margin-top: 15px; }
          input, select { width: 100%; padding: 8px; margin-top: 5px; }
          button {
            margin-top: 6px;
            padding: 2px 7.5px;
            font-size: 0.85em;
            border-radius: 4px;
            border: none;
            background-color: #222;
            color: #fff;
            cursor: pointer;
            min-height: 25px;
          }
          button:hover {
            background-color: #222;
          }
          .advanced { margin-top: 20px; border-top: 1px solid #eee; padding-top: 10px; }
          .server-buttons {
            margin-top: 7.5px;
            display: flex;
            gap: 3px;
            flex-wrap: wrap;
          }
          .server-buttons button {
            flex: 1 1 0;
            min-width: 45px;
            margin-top: 0;
            padding: 2.25px 6px;
            font-size: 0.60em;
            border-radius: 7.5px;
            background-color: #222;
            color: #fff;
            border: none;
          }
          .server-buttons button:hover {
            background-color: #222;
          }
          #serverResponse { width: 100%; height: 100px; margin-top: 16px; resize: vertical; border-radius: 10px; border: 1px solid #eee; }
      </style>
    </head>
    <body>
      <h2>VSLLM Server Configuration</h2>
  <form id="configForm">
        <label>Model Selection</label>
        <select id="model" style="margin-bottom:8px;">
          ${modelOptions}
        </select>
        <button id="refreshModelsBtn" type="button" style="width:100%;margin-bottom:16px;">Refresh Models</button>
        <label>Server URL
          <input type="text" id="url" value="${url}" />
        </label>
        <label>Server Port
          <input type="number" id="port" value="${port}" />
        </label>
        <label>API Key
          <input type="password" id="apiKey" value="${apiKey}" />
        </label>
        <label>
          <input type="checkbox" id="enableLogging" ${enableLogging ? "checked" : ""} /> Enable Logging
        </label>
        <button type="submit">Save Configuration</button>
      </form>
      <div class="server-buttons">
        <button id="startServerBtn" type="button">Start Server</button>
        <button id="stopServerBtn" type="button">Stop Server</button>
        <button id="testServerBtn" type="button">Test Server</button>
      </div>
      <textarea id="serverResponse" readonly placeholder="Server response will appear here..."></textarea>
      <script>
        const vscode = acquireVsCodeApi();
        // Request model list after page loads
        let lastValidModels = [];
        window.addEventListener('DOMContentLoaded', function() {
          document.getElementById('serverResponse').value = '🔄 Loading available models... Please wait.';
          vscode.postMessage({ command: 'getModelList' });
        });
        document.getElementById('refreshModelsBtn').addEventListener('click', function() {
          document.getElementById('serverResponse').value = '🔄 Refreshing model list...';
          vscode.postMessage({ command: 'getModelList' });
        });
        document.getElementById('configForm').addEventListener('submit', function(e) {
          e.preventDefault();
          vscode.postMessage({
            command: 'saveConfig',
            model: document.getElementById('model').value,
            url: document.getElementById('url').value,
            port: parseInt(document.getElementById('port').value, 10),
            apiKey: document.getElementById('apiKey').value,
            enableLogging: document.getElementById('enableLogging').checked
          });
        });
        document.getElementById('startServerBtn').addEventListener('click', function() {
          vscode.postMessage({ command: 'startServer' });
          // After starting server, always try to refresh models
          document.getElementById('serverResponse').value = '🔄 Refreshing model list after server start...';
          vscode.postMessage({ command: 'getModelList' });
        });
        document.getElementById('stopServerBtn').addEventListener('click', function() {
          vscode.postMessage({ command: 'stopServer' });
        });
        document.getElementById('testServerBtn').addEventListener('click', function() {
          vscode.postMessage({ command: 'testServer' });
        });
        window.addEventListener('message', event => {
          const message = event.data;
          if (message.command === 'showServerResponse') {
            document.getElementById('serverResponse').value = message.text;
          }
          if (message.command === 'updateModelList') {
            const modelSelect = document.getElementById('model');
            const currentValue = modelSelect.value;
            // Always clear dropdown first
            while (modelSelect.firstChild) modelSelect.removeChild(modelSelect.firstChild);
            if (message.error) {
              // Log error to console for debugging
              console.error('VSLLM Sidebar: Model list error:', message.error);
              // Show error in dropdown
              const opt = document.createElement('option');
              opt.value = '';
              opt.textContent = '❌ ' + (message.error || 'Error loading models');
              modelSelect.appendChild(opt);
              document.getElementById('serverResponse').value = '❌ Error loading models: ' + message.error;
              return;
            }
            if (message.models && message.models.length > 0) {
              lastValidModels = message.models;
              message.models.forEach(function(m) {
                var opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = [m.vendor, m.family, '(', m.id, ')'].join(' ');
                if (currentValue === m.id) opt.selected = true;
                modelSelect.appendChild(opt);
              });
              document.getElementById('serverResponse').value = '✅ Model list loaded. Please select a model.';
            } else {
              lastValidModels = [];
              const opt = document.createElement('option');
              opt.value = '';
              opt.textContent = 'No models available';
              modelSelect.appendChild(opt);
              document.getElementById('serverResponse').value = '⚠️ No models found. Please check your VS Code LLM setup.';
            }
          }
        });
      </script>
    </body>
    </html>
  `;
}

class VsllmServerSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vsllmServerView';
  private webviewView?: vscode.WebviewView;
  constructor(private readonly context: vscode.ExtensionContext) {}
  async resolveWebviewView(webviewView: vscode.WebviewView) {
    this.webviewView = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getConfigWebviewHtml(webviewView.webview, this.context);
    // After initial render, request model list
    setTimeout(() => {
      if (this.webviewView) {
        console.log("VSLLM Sidebar: Posting initial model list from globalState", this.context.globalState.get<any[]>("vsllmServer.models", []));
        this.webviewView.webview.postMessage({ command: 'updateModelList', models: this.context.globalState.get<any[]>("vsllmServer.models", []) });
      }
    }, 100);
    webviewView.webview.onDidReceiveMessage(async (message) => {
      console.log("VSLLM Sidebar: Received message from webview", message);
      if (message.command === 'saveConfig') {
        const config = vscode.workspace.getConfiguration('vsllmServer');
        await config.update('model', message.model, vscode.ConfigurationTarget.Workspace);
        await config.update('url', message.url, vscode.ConfigurationTarget.Workspace);
        await config.update('port', message.port, vscode.ConfigurationTarget.Workspace);
        await config.update('apiKey', message.apiKey, vscode.ConfigurationTarget.Workspace);
        await config.update('enableLogging', message.enableLogging, vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage('VSLLM Server configuration updated.');
      } else if (message.command === 'startServer') {
        await vscode.commands.executeCommand('vsllmServer.startServer');
      } else if (message.command === 'stopServer') {
        await vscode.commands.executeCommand('vsllmServer.stopServer');
      } else if (message.command === 'testServer') {
        // Get config
        const config = vscode.workspace.getConfiguration('vsllmServer');
        const url = config.get<string>('url', 'http://localhost');
        const port = config.get<number>('port', 8080);
        try {
          const response = await fetch(`${url}:${port}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: config.get<string>('model', ''),
              messages: [{ role: 'user', content: 'Hello!' }],
              max_tokens: 10
            })
          });
          if (!response.ok) {
            throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
          }
          let result;
          try {
            result = await response.json();
          } catch (jsonErr) {
            throw new Error('Failed to parse server response as JSON: ' + (jsonErr as any).message);
          }
          if (this.webviewView) {
            this.webviewView.webview.postMessage({ command: 'showServerResponse', text: JSON.stringify(result, null, 2) });
          }
        } catch (err) {
          console.error('VSLLM Server: testServer error:', err);
          if (this.webviewView) {
            this.webviewView.webview.postMessage({ command: 'showServerResponse', text: 'Server test failed: ' + ((err as any).message || err) });
          }
        }
      } else if (message.command === 'getModelList') {
        console.log("VSLLM Sidebar: getModelList called");
        // Fetch ALL available models from VS Code LM API and pass them to the webview
        let models: any[] = [];
        let errorMsg = '';
        try {
          console.log("VSLLM Sidebar: Checking vscode.lm API", 'lm' in vscode, vscode.lm?.selectChatModels);
          if (!('lm' in vscode) || !vscode.lm?.selectChatModels) {
            errorMsg = '❌ VS Code LM API not available in this environment. Please ensure you have the Copilot extension installed and enabled.';
            console.error("VSLLM Sidebar: LM API not available");
          } else {
            const selector = { vendor: "copilot" };
            console.log("VSLLM Sidebar: Calling selectChatModels with selector", selector);
            const rawModels = await vscode.lm.selectChatModels(selector);
            if (rawModels && rawModels.length > 0) {
              console.log("VSLLM Sidebar: selectChatModels returned:");
              rawModels.forEach(m => console.log("  ", m.id));
            } else {
              console.log("VSLLM Sidebar: selectChatModels returned no models.");
            }
            if (rawModels && rawModels.length > 0) {
              // Map to a simple serializable structure for webview/globalState
              models = rawModels.map(m => ({ id: m.id, vendor: m.vendor, family: m.family }));
            } else {
              errorMsg = '⚠️ No Copilot models found. Please check your Copilot setup and user consent.';
              models = [];
            }
          }
        } catch (err) {
          errorMsg = (err instanceof Error && err.message) ? err.message : 'Failed to fetch models.';
          console.error("VSLLM Sidebar: Error fetching models", err);
          models = [];
        }
        console.log("VSLLM Sidebar: Updating globalState with models", models);
        await this.context.globalState.update("vsllmServer.models", models);
        if (this.webviewView) {
          console.log("VSLLM Sidebar: Posting updateModelList to webview:");
          if (models && models.length > 0) {
            models.forEach(m => console.log("  ", JSON.stringify(m)));
          } else {
            console.log("  No models available.");
          }
          if (errorMsg) {
            console.log("  Error:", errorMsg);
          }
          if (models && models.length > 0) {
            this.webviewView.webview.postMessage({ command: 'updateModelList', models });
          } else {
            this.webviewView.webview.postMessage({ command: 'updateModelList', models: [], error: errorMsg || 'No models available.' });
            this.webviewView.webview.postMessage({ command: 'showServerResponse', text: errorMsg });
          }
        }
      }
    });
  }
  async refreshWebview() {
    if (this.webviewView) {
      this.webviewView.webview.html = await getConfigWebviewHtml(this.webviewView.webview, this.context);
    }
  }
}
export function activate(context: vscode.ExtensionContext) {
  let serverInstance: any = null;
  let sidebarProviderInstance: VsllmServerSidebarProvider | undefined;

  // Start server command
  context.subscriptions.push(
    vscode.commands.registerCommand("vsllmServer.startServer", async () => {
      try {
        const config = vscode.workspace.getConfiguration("vsllmServer");
        const url = config.get<string>("url", "http://localhost");
        const port = config.get<number>("port", 8080);
        vscode.window.showInformationMessage(`Starting VSLLM Server on ${url}:${port}...`);
        serverInstance = await startVsllmServer(context, { url, port });
      } catch (err) {
        console.error("VSLLM Server: startServer error:", err);
      }
    })
  );

  // Stop server command
  context.subscriptions.push(
    vscode.commands.registerCommand("vsllmServer.stopServer", async () => {
      try {
        if (!serverInstance) {
          vscode.window.showWarningMessage("VSLLM Server is not running.");
          return;
        }
        await stopVsllmServer(serverInstance);
        serverInstance = null;
        vscode.window.showInformationMessage("VSLLM Server stopped.");
      } catch (err) {
        console.error("VSLLM Server: stopServer error:", err);
      }
    })
  );

  // Select model command
  context.subscriptions.push(
    vscode.commands.registerCommand("vsllmServer.selectModel", async () => {
      try {
        if (!('lm' in vscode) || !vscode.lm?.selectChatModels) {
          vscode.window.showErrorMessage('VS Code LM API not available in this environment.');
          return;
        }
        const selector = { vendor: "copilot", family: "gpt-4o" };
        vscode.window.showInformationMessage('Selecting Copilot GPT-4o models...');
        const models = await vscode.lm.selectChatModels(selector);
        if (!models || models.length === 0) {
          vscode.window.showWarningMessage('No Copilot GPT-4o models available.');
          return;
        }
        const modelNames = models.map(m => `${m.vendor} ${m.family} (${m.id})`).join(', ');
        vscode.window.showInformationMessage(`Available models: ${modelNames}`);
      } catch (err) {
        const errorMsg = (err instanceof Error && err.message) ? err.message : String(err);
        if (errorMsg.includes('consent')) {
          vscode.window.showWarningMessage('User consent required for Copilot models.');
        } else {
          vscode.window.showErrorMessage('Failed to select models: ' + errorMsg);
        }
      }
    })
  );

  // Restart server command
  context.subscriptions.push(
    vscode.commands.registerCommand("vsllmServer.restartServer", async () => {
      try {
        const config = vscode.workspace.getConfiguration("vsllmServer");
        const url = config.get<string>("url", "http://localhost");
        const port = config.get<number>("port", 8080);
        if (serverInstance) {
          await stopVsllmServer(serverInstance);
          serverInstance = null;
        }
        vscode.window.showInformationMessage(`Restarting VSLLM Server on ${url}:${port}...`);
        serverInstance = await startVsllmServer(context, { url, port });
      } catch (err) {
        console.error("VSLLM Server: restartServer error:", err);
      }
    })
  );

  // Configure server command
  context.subscriptions.push(
    vscode.commands.registerCommand("vsllmServer.openConfigPanel", () => {
      try {
        vscode.commands.executeCommand("workbench.action.openSettings", "@ext:vsllm-server");
      } catch (err) {
        console.error("VSLLM Server: openConfigPanel error:", err);
      }
    })
  );

  // Register the sidebar view provider
  try {
    sidebarProviderInstance = new VsllmServerSidebarProvider(context);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        VsllmServerSidebarProvider.viewType,
        sidebarProviderInstance
      )
    );
  } catch (err) {
    console.error("VSLLM Server: WebviewViewProvider registration error:", err);
  }
  console.log("VSLLM Server: Extension activate end");
}
