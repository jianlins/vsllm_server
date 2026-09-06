import * as vscode from "vscode";
import { startVsllmServer, stopVsllmServer } from "./server";
import { MonitorPanel } from "./monitorPanel";
import { monitor } from "./monitor";
const fetch = require('node-fetch');

/** A real model round-trip can take a while on a cold Copilot connection. */
const SELF_TEST_TIMEOUT_MS = 45000;


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
          .server-control {
            margin-top: 12px;
            display: flex;
            align-items: center;
            gap: 10px;
          }
          /* Traffic-light switch: grey = stopped, amber = starting/testing, green = tested and ready, red = failed. */
          .switch {
            position: relative;
            flex: 0 0 auto;
            width: 38px;
            height: 20px;
            min-height: 0;
            padding: 0;
            margin: 0;
            border: none;
            border-radius: 10px;
            background-color: #6b6b6b;
            cursor: pointer;
            transition: background-color .2s ease;
          }
          .switch:hover { background-color: #6b6b6b; }
          .switch .knob {
            position: absolute;
            top: 2px;
            left: 2px;
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: #fff;
            transition: transform .2s ease;
          }
          .switch.pos-on .knob { transform: translateX(18px); }
          .switch.off, .switch.off:hover { background-color: #6b6b6b; }
          .switch.pending, .switch.pending:hover { background-color: #d8a300; animation: switchPulse 1.2s ease-in-out infinite; }
          .switch.on, .switch.on:hover { background-color: #2ea043; }
          .switch.error, .switch.error:hover { background-color: #d13438; }
          .switch:disabled { cursor: progress; }
          @keyframes switchPulse { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }
          .server-status { min-width: 0; line-height: 1.35; }
          #serverStatusText { font-size: 0.85em; font-weight: 600; }
          #serverStatusDetail { font-size: 0.72em; opacity: .75; word-break: break-word; }
          #statusMessage {
            margin-top: 8px;
            font-size: 0.75em;
            opacity: .8;
            line-height: 1.4;
            white-space: pre-wrap;
            word-break: break-word;
            max-height: 90px;
            overflow: auto;
          }
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
      <div class="server-control">
        <button id="serverToggle" type="button" class="switch off" role="switch" aria-checked="false" title="Start the VSLLM server">
          <span class="knob"></span>
        </button>
        <div class="server-status">
          <div id="serverStatusText" title="Click to re-run the server test" style="cursor:pointer;">Stopped</div>
          <div id="serverStatusDetail">Click the switch to start</div>
        </div>
      </div>
      <button id="openMonitorBtn" type="button" style="width:100%;margin-top:8px;">📊 Open Traffic Monitor</button>
      <div id="liveStats" style="margin-top:8px;font-size:0.78em;opacity:.8;line-height:1.5;"></div>
      <div id="statusMessage"></div>
      <script>
        const vscode = acquireVsCodeApi();
        // Request model list after page loads
        let lastValidModels = [];
        let currentPhase = 'stopped';
        function setMessage(text) {
          document.getElementById('statusMessage').textContent = text || '';
        }
        const PHASES = {
          stopped: { cls: 'off', on: false, label: 'Stopped', hint: 'Click the switch to start' },
          starting: { cls: 'pending', on: true, label: 'Starting...', hint: '' },
          testing: { cls: 'pending', on: true, label: 'Testing...', hint: '' },
          ready: { cls: 'on', on: true, label: 'Running', hint: '' },
          error: { cls: 'error', on: false, label: 'Error', hint: '' }
        };
        function renderServerState(srv) {
          srv = srv || {};
          currentPhase = srv.phase || (srv.running ? 'ready' : 'stopped');
          const phase = PHASES[currentPhase] || PHASES.stopped;
          const endpoint = (srv.url || '') + (srv.port ? ':' + srv.port : '');
          const toggle = document.getElementById('serverToggle');
          // Only the bind step is uninterruptible; a slow model round-trip must stay cancellable.
          const busy = currentPhase === 'starting';
          const knobOn = currentPhase === 'error' ? !!srv.running : phase.on;
          toggle.className = 'switch ' + phase.cls + (knobOn ? ' pos-on' : '');
          toggle.setAttribute('aria-checked', knobOn ? 'true' : 'false');
          toggle.disabled = busy;
          let label = phase.label;
          let detail = phase.hint;
          if (currentPhase === 'starting') {
            detail = endpoint;
          } else if (currentPhase === 'testing') {
            detail = 'sending a test message to ' + endpoint;
          } else if (currentPhase === 'ready') {
            detail = endpoint + (srv.detail ? ' · ' + srv.detail : '');
          } else if (currentPhase === 'error') {
            label = srv.running ? 'Test failed' : 'Failed to start';
            detail = srv.detail || 'See the VSLLM output for details';
          }
          toggle.title = busy
            ? 'Server is starting'
            : (srv.running ? 'Stop the VSLLM server' : 'Start the VSLLM server');
          document.getElementById('serverStatusText').textContent = label;
          const detailEl = document.getElementById('serverStatusDetail');
          detailEl.textContent = detail;
          detailEl.title = detail;
        }
        window.addEventListener('DOMContentLoaded', function() {
          setMessage('🔄 Loading available models... Please wait.');
          vscode.postMessage({ command: 'getModelList' });
          vscode.postMessage({ command: 'getServerState' });
        });
        document.getElementById('refreshModelsBtn').addEventListener('click', function() {
          setMessage('🔄 Refreshing model list...');
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
        document.getElementById('serverToggle').addEventListener('click', function() {
          if (currentPhase === 'starting') {
            return;
          }
          if (currentPhase === 'testing') {
            // The server is already listening, so allow cancelling a slow test by stopping it.
            vscode.postMessage({ command: 'stopServer' });
            return;
          }
          if (currentPhase === 'ready' || (currentPhase === 'error' && document.getElementById('serverToggle').classList.contains('pos-on'))) {
            vscode.postMessage({ command: 'stopServer' });
            return;
          }
          renderServerState({ phase: 'starting', running: false });
          vscode.postMessage({ command: 'startServer' });
          // After starting the server, always try to refresh models
          vscode.postMessage({ command: 'getModelList' });
        });
        document.getElementById('serverStatusText').addEventListener('click', function() {
          if (currentPhase === 'ready' || currentPhase === 'error') {
            vscode.postMessage({ command: 'testServer' });
          }
        });
        document.getElementById('openMonitorBtn').addEventListener('click', function() {
          vscode.postMessage({ command: 'openMonitor' });
        });
        window.addEventListener('message', event => {
          const message = event.data;
          if (message.command === 'showServerResponse') {
            setMessage(message.text);
          }
          if (message.command === 'serverState') {
            renderServerState(message.server);
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
              setMessage('❌ Error loading models: ' + message.error);
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
              setMessage('✅ Model list loaded. Please select a model.');
            } else {
              lastValidModels = [];
              const opt = document.createElement('option');
              opt.value = '';
              opt.textContent = 'No models available';
              modelSelect.appendChild(opt);
              setMessage('⚠️ No models found. Please check your VS Code LLM setup.');
            }
          }
        });
      </script>
    </body>
    </html>
  `;
}

/**
 * Probes the running server exactly like a real client would: it sends a tiny chat completion
 * and requires actual text back, so the switch only turns green when the whole path — binding,
 * API key check, VS Code LM API and response serialization — really works.
 */
async function runServerSelfTest(): Promise<{ ok: boolean; detail: string }> {
  const config = vscode.workspace.getConfiguration('vsllmServer');
  const url = config.get<string>('url', 'http://localhost');
  const port = config.get<number>('port', 8801);
  const apiKey = config.get<string>('apiKey', '').trim();
  const model = config.get<string>('model', '').trim();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  const payload: Record<string, unknown> = {
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 16,
    stream: false,
  };
  if (model) {
    payload.model = model;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SELF_TEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${url}:${port}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      let reason = `HTTP ${response.status} ${response.statusText}`;
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.error?.message) {
          reason += `: ${parsed.error.message}`;
        }
      } catch {
        // A non-JSON error body is already covered by the status text.
      }
      return { ok: false, detail: reason };
    }
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return { ok: false, detail: 'Server returned a non-JSON response' };
    }
    const reply = body?.choices?.[0]?.message?.content;
    const text = typeof reply === 'string' ? reply.trim() : '';
    if (!text) {
      return { ok: false, detail: 'Server replied but the model returned no text' };
    }
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const modelName = typeof body?.model === 'string' && body.model ? body.model : model || 'default model';
    return { ok: true, detail: `${modelName} replied in ${seconds}s` };
  } catch (err) {
    const raw = (err as any)?.message || String(err);
    const message =
      (err as any)?.name === 'AbortError'
        ? `No response within ${Math.round(SELF_TEST_TIMEOUT_MS / 1000)}s`
        : // node-fetch prefixes the whole URL; the part after "reason:" is what actually helps.
          (raw.split('reason:').pop() || raw).trim();
    return { ok: false, detail: message };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs the self-test and drives the traffic light from amber to green or red. */
async function verifyServerAndReportPhase(): Promise<boolean> {
  if (!monitor.getServerState().running) {
    monitor.setServerPhase('stopped');
    return false;
  }
  monitor.setServerPhase('testing');
  const result = await runServerSelfTest();
  if (!monitor.getServerState().running) {
    // The user stopped the server while the probe was in flight; the result is stale.
    return false;
  }
  monitor.setServerPhase(result.ok ? 'ready' : 'error', result.detail);
  if (!result.ok) {
    console.error('VSLLM Server: self-test failed:', result.detail);
  }
  return result.ok;
}

class VsllmServerSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vsllmServerView';
  private webviewView?: vscode.WebviewView;
  private statsSubscribed = false;
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
    // Mirror live traffic counters into the sidebar so the user notices activity without opening the panel.
    if (!this.statsSubscribed) {
      this.statsSubscribed = true;
      this.context.subscriptions.push(
        monitor.onDidChange((event) => {
          if ((event.type === 'upsert' || event.type === 'cleared') && this.webviewView?.visible) {
            this.webviewView.webview.postMessage({ command: 'updateStats', stats: event.stats });
          }
          if (event.type === 'server') {
            this.webviewView?.webview.postMessage({ command: 'serverState', server: event.server });
          }
        })
      );
    }
    this.postServerState();
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
      } else if (message.command === 'startServer') {
        await vscode.commands.executeCommand('vsllmServer.startServer');
      } else if (message.command === 'stopServer') {
        await vscode.commands.executeCommand('vsllmServer.stopServer');
      } else if (message.command === 'openMonitor') {
        await vscode.commands.executeCommand('vsllmServer.openMonitor');
      } else if (message.command === 'testServer') {
        await verifyServerAndReportPhase();
      } else if (message.command === 'getServerState') {
        this.postServerState();
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

  postServerState() {
    this.webviewView?.webview.postMessage({ command: 'serverState', server: monitor.getServerState() });
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
        const port = config.get<number>("port", 8801);
        monitor.setServerPhase("starting");
        serverInstance = await startVsllmServer(context, { url, port });
        // Turn the light green only after the endpoint answers a real request.
        await verifyServerAndReportPhase();
      } catch (err) {
        serverInstance = null;
        console.error("VSLLM Server: startServer error:", err);
        monitor.setServerPhase("error", (err as any)?.message || String(err));
      }
    })
  );

  // Stop server command
  context.subscriptions.push(
    vscode.commands.registerCommand("vsllmServer.stopServer", async () => {
      try {
        if (!serverInstance) {
          vscode.window.showWarningMessage("VSLLM Server is not running.");
          monitor.setServerPhase("stopped");
          return;
        }
        await stopVsllmServer(serverInstance);
        serverInstance = null;
        vscode.window.showInformationMessage("VSLLM Server stopped.");
      } catch (err) {
        console.error("VSLLM Server: stopServer error:", err);
        monitor.setServerPhase("error", (err as any)?.message || String(err));
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
        const port = config.get<number>("port", 8801);
        if (serverInstance) {
          await stopVsllmServer(serverInstance);
          serverInstance = null;
        }
        monitor.setServerPhase("starting");
        serverInstance = await startVsllmServer(context, { url, port });
        await verifyServerAndReportPhase();
      } catch (err) {
        serverInstance = null;
        console.error("VSLLM Server: restartServer error:", err);
        monitor.setServerPhase("error", (err as any)?.message || String(err));
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

  // Status bar entry: live request counter that opens the monitor.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "vsllmServer.openMonitor";
  statusItem.tooltip = "VSLLM Server traffic — click to open the monitor";
  const renderStatus = () => {
    const { stats, server } = monitor.getSnapshot();
    const phase = server.phase ?? (server.running ? "ready" : "stopped");
    const icons: Record<string, string> = {
      stopped: "$(circle-slash)",
      starting: "$(loading~spin)",
      testing: "$(loading~spin)",
      ready: "$(radio-tower)",
      error: "$(error)",
    };
    const colors: Record<string, string | undefined> = {
      stopped: undefined,
      starting: "charts.yellow",
      testing: "charts.yellow",
      ready: "charts.green",
      error: "charts.red",
    };
    const dot = icons[phase] ?? "$(circle-slash)";
    const color = colors[phase];
    statusItem.color = color ? new vscode.ThemeColor(color) : undefined;
    statusItem.text = `${dot} VSLLM ${stats.totalRequests}${stats.activeRequests ? ` (${stats.activeRequests} live)` : ""}${stats.errorRequests ? ` $(error)${stats.errorRequests}` : ""}`;
    statusItem.tooltip =
      phase === "ready"
        ? `VSLLM Server ready on ${server.url}:${server.port} — click to open the monitor`
        : phase === "error"
          ? `VSLLM Server problem: ${server.detail ?? "unknown error"} — click to open the monitor`
          : phase === "stopped"
            ? "VSLLM Server stopped — click to open the monitor"
            : "VSLLM Server starting — click to open the monitor";
    statusItem.show();
  };
  renderStatus();
  context.subscriptions.push(statusItem, monitor.onDidChange(renderStatus));

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
