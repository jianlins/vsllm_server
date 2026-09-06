import * as vscode from "vscode";
import { startVsllmServer, stopVsllmServer } from "./server";
import { MonitorPanel } from "./monitorPanel";
import { monitor } from "./monitor";
const fetch = require('node-fetch');


// ...existing code...
// VSLLM Server VSCode extension entrypoint with configuration and lifecycle commands

// ...existing code...


function getConfigWebviewHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
  // Get current config values from VS Code settings
  const config = vscode.workspace.getConfiguration('vsllmServer');
  let url = config.get<string>('url', 'http://localhost');
  let port = config.get<number>('port', 8801);
  let model = config.get<string>('model', '');
  let apiKey = config.get<string>('apiKey', '');
  let enableLogging = config.get<boolean>('enableLogging', false);
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
          .switch-row {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 12px;
          }
          .switch-row .caption { font-size: 0.85em; font-weight: 600; }
          .switch-row .state { font-size: 0.75em; opacity: .75; margin-left: auto; text-align: right; }
          .switch { position: relative; display: inline-flex; align-items: center; cursor: pointer; }
          .switch input { position: absolute; opacity: 0; width: 0; height: 0; }
          .switch .track {
            display: inline-block;
            position: relative;
            width: 34px;
            height: 18px;
            border-radius: 9px;
            background: var(--vscode-checkbox-background, #6b6b6b);
            border: 1px solid var(--vscode-checkbox-border, #8a8a8a);
            transition: background .15s ease;
          }
          .switch .thumb {
            position: absolute;
            top: 2px;
            left: 2px;
            width: 14px;
            height: 14px;
            border-radius: 50%;
            background: var(--vscode-foreground, #ddd);
            transition: transform .15s ease;
          }
          .switch input:checked + .track {
            background: var(--vscode-testing-iconPassed, #2ea043);
            border-color: var(--vscode-testing-iconPassed, #2ea043);
          }
          .switch input:checked + .track .thumb { transform: translateX(16px); background: #fff; }
          .switch input:focus-visible + .track { outline: 1px solid var(--vscode-focusBorder, #0078d4); outline-offset: 2px; }
          .switch input:disabled + .track { opacity: .5; }
          .switch input:disabled { cursor: progress; }
          #testServerBtn { width: 100%; }
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
      <div class="switch-row">
        <label class="switch" title="Turn the VSLLM server on or off">
          <input type="checkbox" id="serverSwitch" />
          <span class="track"><span class="thumb"></span></span>
        </label>
        <span class="caption">Server</span>
        <span class="state" id="serverState">Stopped</span>
      </div>
      <div class="switch-row">
        <label class="switch" title="Show or hide the traffic monitor">
          <input type="checkbox" id="monitorSwitch" />
          <span class="track"><span class="thumb"></span></span>
        </label>
        <span class="caption">📊 Traffic Monitor</span>
        <span class="state" id="monitorState">Closed</span>
      </div>
      <button id="testServerBtn" type="button">Test Server</button>
      <div id="liveStats" style="margin-top:8px;font-size:0.78em;opacity:.8;line-height:1.5;"></div>
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
        document.getElementById('serverSwitch').addEventListener('change', function() {
          const wantRunning = this.checked;
          this.disabled = true;
          document.getElementById('serverState').textContent = wantRunning ? 'Starting...' : 'Stopping...';
          vscode.postMessage({ command: 'setServer', running: wantRunning });
          if (wantRunning) {
            // A fresh start is the moment the model list is most likely to have changed.
            document.getElementById('serverResponse').value = '🔄 Refreshing model list after server start...';
            vscode.postMessage({ command: 'getModelList' });
          }
        });
        document.getElementById('monitorSwitch').addEventListener('change', function() {
          this.disabled = true;
          vscode.postMessage({ command: 'setMonitor', open: this.checked });
        });
        document.getElementById('testServerBtn').addEventListener('click', function() {
          vscode.postMessage({ command: 'testServer' });
        });
        window.addEventListener('message', event => {
          const message = event.data;
          if (message.command === 'showServerResponse') {
            document.getElementById('serverResponse').value = message.text;
          }
          if (message.command === 'updateToggles') {
            const serverSwitch = document.getElementById('serverSwitch');
            serverSwitch.checked = !!message.serverRunning;
            serverSwitch.disabled = false;
            document.getElementById('serverState').textContent = message.serverRunning
              ? 'Running · ' + message.serverAddress
              : 'Stopped';
            const monitorSwitch = document.getElementById('monitorSwitch');
            monitorSwitch.checked = !!message.monitorOpen;
            monitorSwitch.disabled = false;
            document.getElementById('monitorState').textContent = message.monitorOpen ? 'Open' : 'Closed';
          }
          if (message.command === 'updateStats') {
            var s = message.stats;
            document.getElementById('liveStats').textContent =
              'Requests: ' + s.totalRequests + ' · in flight: ' + s.activeRequests +
              ' · errors: ' + s.errorRequests + ' | ' +
              'In: ' + s.bytesIn + ' B · Out: ' + s.bytesOut + ' B · tool calls: ' + s.toolCallsEmitted;
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
  private subscribed = false;
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly isServerRunning: () => boolean
  ) {}

  /** Pushes the authoritative server/monitor state so both switches always mirror reality. */
  private postToggleState() {
    if (!this.webviewView) {
      return;
    }
    const { server } = monitor.getSnapshot();
    const running = this.isServerRunning();
    this.webviewView.webview.postMessage({
      command: 'updateToggles',
      serverRunning: running,
      serverAddress: `${server.url}:${server.port}`,
      monitorOpen: MonitorPanel.isOpen(),
    });
  }

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
    this.postToggleState();
    // The webview is torn down while hidden, so re-sync the switches whenever it comes back.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postToggleState();
      }
    });
    // Mirror live traffic counters into the sidebar so the user notices activity without opening the panel.
    if (!this.subscribed) {
      this.subscribed = true;
      this.context.subscriptions.push(
        monitor.onDidChange((event) => {
          if (!this.webviewView?.visible) {
            return;
          }
          if (event.type === 'upsert' || event.type === 'cleared') {
            this.webviewView.webview.postMessage({ command: 'updateStats', stats: event.stats });
          } else if (event.type === 'server') {
            this.postToggleState();
          }
        }),
        MonitorPanel.onDidChangeState(() => this.postToggleState())
      );
    }
    webviewView.webview.onDidReceiveMessage(async (message) => {
      console.log("VSLLM Sidebar: Received message from webview", message);
      if (message.command === 'saveConfig') {
        const config = vscode.workspace.getConfiguration('vsllmServer');
        await config.update('model', message.model, vscode.ConfigurationTarget.Workspace);
        await config.update('url', message.url, vscode.ConfigurationTarget.Workspace);
        await config.update('port', message.port, vscode.ConfigurationTarget.Workspace);
        // The API key goes to user settings: .vscode/settings.json is often committed.
        await config.update('apiKey', message.apiKey, vscode.ConfigurationTarget.Global);
        try {
          if (config.inspect<string>('apiKey')?.workspaceValue !== undefined) {
            await config.update('apiKey', undefined, vscode.ConfigurationTarget.Workspace);
            vscode.window.showWarningMessage(
              'Removed vsllmServer.apiKey from workspace settings and stored it in your user settings, ' +
              'because .vscode/settings.json is usually tracked by source control.'
            );
          }
        } catch {
          // The setting is machine-scoped, so a stale workspace entry is ignored anyway.
        }
        await config.update('enableLogging', message.enableLogging, vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage('VSLLM Server configuration updated.');
      } else if (message.command === 'setServer') {
        await vscode.commands.executeCommand('vsllmServer.toggleServer', !!message.running);
        // Always re-sync: a failed start leaves the switch out of step with reality.
        this.postToggleState();
      } else if (message.command === 'setMonitor') {
        await vscode.commands.executeCommand('vsllmServer.toggleMonitor', !!message.open);
        this.postToggleState();
      } else if (message.command === 'openMonitor') {
        await vscode.commands.executeCommand('vsllmServer.openMonitor');
      } else if (message.command === 'testServer') {
        // Get config
        const config = vscode.workspace.getConfiguration('vsllmServer');
        const url = config.get<string>('url', 'http://localhost');
        const port = config.get<number>('port', 8801);
        const apiKey = config.get<string>('apiKey', '').trim();
        try {
          const testHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
          if (apiKey) {
            testHeaders['Authorization'] = `Bearer ${apiKey}`;
          }
          const response = await fetch(`${url}:${port}/v1/chat/completions`, {
            method: 'POST',
            headers: testHeaders,
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
  refreshWebview() {
    if (this.webviewView) {
      this.webviewView.webview.html = getConfigWebviewHtml(this.webviewView.webview, this.context);
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
        if (serverInstance) {
          vscode.window.showWarningMessage("VSLLM Server is already running.");
          return;
        }
        const config = vscode.workspace.getConfiguration("vsllmServer");
        const url = config.get<string>("url", "http://localhost");
        const port = config.get<number>("port", 8801);
        vscode.window.showInformationMessage(`Starting VSLLM Server on ${url}:${port}...`);
        serverInstance = await startVsllmServer(context, { url, port });
      } catch (err) {
        serverInstance = null;
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

  // Toggle server command: single entry point behind the on/off switches.
  context.subscriptions.push(
    vscode.commands.registerCommand("vsllmServer.toggleServer", async (desired?: boolean) => {
      const target = typeof desired === "boolean" ? desired : !serverInstance;
      if (target === !!serverInstance) {
        return !!serverInstance;
      }
      await vscode.commands.executeCommand(target ? "vsllmServer.startServer" : "vsllmServer.stopServer");
      return !!serverInstance;
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
        const port = config.get<number>("port", 8801);
        if (serverInstance) {
          await stopVsllmServer(serverInstance);
          serverInstance = null;
        }
        vscode.window.showInformationMessage(`Restarting VSLLM Server on ${url}:${port}...`);
        serverInstance = await startVsllmServer(context, { url, port });
      } catch (err) {
        serverInstance = null;
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

  // Open traffic monitor command
  context.subscriptions.push(
    vscode.commands.registerCommand("vsllmServer.openMonitor", () => {
      MonitorPanel.show(context);
    })
  );

  // Close traffic monitor command
  context.subscriptions.push(
    vscode.commands.registerCommand("vsllmServer.closeMonitor", () => {
      MonitorPanel.close();
    })
  );

  // Toggle traffic monitor command: lets the user switch monitoring off once they are done.
  context.subscriptions.push(
    vscode.commands.registerCommand("vsllmServer.toggleMonitor", (desired?: boolean) => {
      const target = typeof desired === "boolean" ? desired : !MonitorPanel.isOpen();
      if (target) {
        MonitorPanel.show(context);
      } else {
        MonitorPanel.close();
      }
      return MonitorPanel.isOpen();
    })
  );

  // Status bar entry: live request counter that opens the monitor.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "vsllmServer.openMonitor";
  statusItem.tooltip = "VSLLM Server traffic — click to open the monitor";
  const renderStatus = () => {
    const { stats, server } = monitor.getSnapshot();
    const dot = server.running ? "$(radio-tower)" : "$(circle-slash)";
    statusItem.text = `${dot} VSLLM ${stats.totalRequests}${stats.activeRequests ? ` (${stats.activeRequests} live)` : ""}${stats.errorRequests ? ` $(error)${stats.errorRequests}` : ""}`;
    statusItem.show();
  };
  renderStatus();
  context.subscriptions.push(statusItem, monitor.onDidChange(renderStatus));

  // Register the sidebar view provider
  try {
    sidebarProviderInstance = new VsllmServerSidebarProvider(context, () => serverInstance !== null);
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
