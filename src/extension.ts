import * as vscode from "vscode";
import { startVsllmServer, stopVsllmServer } from "./server";
import { MonitorPanel } from "./monitorPanel";
import { monitor } from "./monitor";
const fetch = require('node-fetch');


// ...existing code...
// VSLLM Server VSCode extension entrypoint with configuration and lifecycle commands

// ...existing code...

const MODELS_CACHE_KEY = "vsllmServer.models";

/** A real model round-trip can take a while on a cold Copilot connection. */
const SELF_TEST_TIMEOUT_MS = 45000;

type ModelInfo = { id: string; vendor: string; family: string };

type ModelFetchResult = { models: ModelInfo[]; error?: string };

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Embedding JSON in an inline <script> requires neutralising "</script>" sequences.
function toInlineJson(value: unknown): string {
  return JSON.stringify(value ?? null).replace(/</g, "\\u003c");
}

/**
 * Caches the VS Code chat models so the sidebar can render instantly from the last known
 * list while a fresh lookup runs in the background. Concurrent refreshes share one lookup.
 */
class ModelCatalog {
  private inFlight: Promise<ModelFetchResult> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  getCached(): ModelInfo[] {
    return this.context.globalState.get<ModelInfo[]>(MODELS_CACHE_KEY, []) ?? [];
  }

  refresh(): Promise<ModelFetchResult> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const pending = this.fetchModels().then(
      async (result) => {
        // A failed lookup (e.g. Copilot still starting up) must not wipe a usable cache.
        if (result.models.length > 0 || !result.error) {
          await this.context.globalState.update(MODELS_CACHE_KEY, result.models);
        }
        return result;
      },
      (err) => ({ models: [] as ModelInfo[], error: err instanceof Error ? err.message : String(err) })
    );
    this.inFlight = pending.finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetchModels(): Promise<ModelFetchResult> {
    try {
      if (!('lm' in vscode) || !vscode.lm?.selectChatModels) {
        return {
          models: [],
          error: 'VS Code LM API not available in this environment. Please ensure you have the Copilot extension installed and enabled.',
        };
      }
      const rawModels = await vscode.lm.selectChatModels({ vendor: "copilot" });
      if (!rawModels || rawModels.length === 0) {
        return { models: [], error: 'No Copilot models found. Please check your Copilot setup and user consent.' };
      }
      return { models: rawModels.map((m) => ({ id: m.id, vendor: m.vendor, family: m.family })) };
    } catch (err) {
      return { models: [], error: err instanceof Error && err.message ? err.message : 'Failed to fetch models.' };
    }
  }
}

function getConfigWebviewHtml(catalog: ModelCatalog): string {
  // Get current config values from VS Code settings
  const config = vscode.workspace.getConfiguration('vsllmServer');
  let url = config.get<string>('url', 'http://localhost');
  let port = config.get<number>('port', 8801);
  let model = config.get<string>('model', '');
  let apiKey = config.get<string>('apiKey', '');
  // Render the last known models straight into the markup so the form is usable on first paint.
  const cachedModels = catalog.getCached();
  const modelOptions = cachedModels.length > 0
    ? cachedModels
        .map((m) => {
          const label = `${m.vendor} ${m.family} ( ${m.id} )`;
          return `<option value="${escapeHtml(m.id)}"${m.id === model ? " selected" : ""}>${escapeHtml(label)}</option>`;
        })
        .join("")
    : `<option value="${escapeHtml(model)}">${model ? escapeHtml(model) : "⏳ Loading models…"}</option>`;
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
          /* Traffic light: amber while starting or being tested, red when the server failed. */
          .switch.pending input + .track, .switch.pending input:checked + .track {
            background: #d8a300;
            border-color: #d8a300;
            animation: switchPulse 1.2s ease-in-out infinite;
          }
          .switch.failed input + .track, .switch.failed input:checked + .track {
            background: #d13438;
            border-color: #d13438;
          }
          @keyframes switchPulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
          .switch input:focus-visible + .track { outline: 1px solid var(--vscode-focusBorder, #0078d4); outline-offset: 2px; }
          .switch input:disabled + .track { opacity: .5; }
          .switch input:disabled { cursor: progress; }
          #modelStatus { font-size: 0.72em; opacity: .75; min-height: 1.2em; margin-bottom: 8px; }
      </style>
    </head>
    <body>
      <h2>VSLLM Server Configuration</h2>
  <form id="configForm">
        <label>Model Selection</label>
        <select id="model" style="margin-bottom:4px;">
          ${modelOptions}
        </select>
        <div id="modelStatus"></div>
        <button id="refreshModelsBtn" type="button" style="width:100%;margin-bottom:16px;">Refresh Models</button>
        <label>Server URL
          <input type="text" id="url" value="${escapeHtml(url)}" />
        </label>
        <label>Server Port
          <input type="number" id="port" value="${escapeHtml(String(port))}" />
        </label>
        <label>API Key
          <input type="password" id="apiKey" value="${escapeHtml(apiKey)}" />
        </label>
        <button type="submit">Save Configuration</button>
      </form>
      <div class="switch-row">
        <label class="switch" id="serverSwitchLabel" title="Turn the VSLLM server on or off">
          <input type="checkbox" id="serverSwitch" />
          <span class="track"><span class="thumb"></span></span>
        </label>
        <span class="caption">Server</span>
        <span class="state" id="serverState" title="Click to test the server again">Stopped</span>
      </div>
      <div class="switch-row">
        <label class="switch" title="Show or hide the traffic monitor">
          <input type="checkbox" id="monitorSwitch" />
          <span class="track"><span class="thumb"></span></span>
        </label>
        <span class="caption">📊 Traffic Monitor</span>
        <span class="state" id="monitorState">Closed</span>
      </div>
      <div id="liveStats" style="margin-top:8px;font-size:0.78em;opacity:.8;line-height:1.5;"></div>
      <script>
        const vscode = acquireVsCodeApi();
        const savedModel = ${toInlineJson(model)};
        let lastValidModels = ${toInlineJson(cachedModels)};

        function setModelStatus(text) {
          document.getElementById('modelStatus').textContent = text || '';
        }
        function renderModels(models) {
          const modelSelect = document.getElementById('model');
          const desired = modelSelect.value || savedModel;
          while (modelSelect.firstChild) modelSelect.removeChild(modelSelect.firstChild);
          models.forEach(function(m) {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = [m.vendor, m.family, '(', m.id, ')'].join(' ');
            if (desired === m.id) opt.selected = true;
            modelSelect.appendChild(opt);
          });
        }

        // The form is already interactive; this only asks for a fresher list.
        setModelStatus(lastValidModels.length > 0 ? '⏳ Refreshing model list…' : '⏳ Loading models…');
        document.getElementById('refreshModelsBtn').addEventListener('click', function() {
          setModelStatus('⏳ Refreshing model list…');
          vscode.postMessage({ command: 'getModelList' });
        });
        document.getElementById('configForm').addEventListener('submit', function(e) {
          e.preventDefault();
          vscode.postMessage({
            command: 'saveConfig',
            model: document.getElementById('model').value,
            url: document.getElementById('url').value,
            port: parseInt(document.getElementById('port').value, 10),
            apiKey: document.getElementById('apiKey').value
          });
        });
        document.getElementById('serverSwitch').addEventListener('change', function() {
          const wantRunning = this.checked;
          this.disabled = true;
          document.getElementById('serverSwitchLabel').className = 'switch pending';
          document.getElementById('serverState').textContent = wantRunning ? 'Starting...' : 'Stopping...';
          vscode.postMessage({ command: 'setServer', running: wantRunning });
          if (wantRunning) {
            // A fresh start is the moment the model list is most likely to have changed.
            setModelStatus('⏳ Refreshing model list…');
            vscode.postMessage({ command: 'getModelList' });
          }
        });
        document.getElementById('monitorSwitch').addEventListener('change', function() {
          this.disabled = true;
          vscode.postMessage({ command: 'setMonitor', open: this.checked });
        });
        document.getElementById('serverState').addEventListener('click', function() {
          // Re-run the readiness check on demand; ignored while the server is off or already busy.
          vscode.postMessage({ command: 'testServer' });
        });
        window.addEventListener('message', event => {
          const message = event.data;
          if (message.command === 'updateToggles') {
            const serverSwitch = document.getElementById('serverSwitch');
            const phase = message.serverPhase || (message.serverRunning ? 'ready' : 'stopped');
            const busy = phase === 'starting' || phase === 'testing';
            serverSwitch.checked = !!message.serverRunning || busy;
            // Only the bind step is uninterruptible; a slow model round-trip stays cancellable.
            serverSwitch.disabled = phase === 'starting';
            document.getElementById('serverSwitchLabel').className =
              'switch' + (busy ? ' pending' : phase === 'error' ? ' failed' : '');
            const stateEl = document.getElementById('serverState');
            if (phase === 'starting') {
              stateEl.textContent = 'Starting...';
            } else if (phase === 'testing') {
              stateEl.textContent = 'Testing...';
            } else if (phase === 'error') {
              stateEl.textContent = (message.serverRunning ? 'Test failed · ' : 'Failed · ') +
                (message.serverDetail || 'see the console for details');
            } else if (message.serverRunning) {
              stateEl.textContent = 'Running · ' + message.serverAddress +
                (message.serverDetail ? ' · ' + message.serverDetail : '');
            } else {
              stateEl.textContent = 'Stopped';
            }
            stateEl.title = message.serverRunning && !busy
              ? 'Click to test the server again'
              : (message.serverDetail || '');
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
            if (message.loading) {
              // A lookup is still running: keep whatever is already selectable.
              if (message.models && message.models.length > 0) {
                lastValidModels = message.models;
                renderModels(message.models);
              }
              setModelStatus(lastValidModels.length > 0 ? '⏳ Refreshing model list…' : '⏳ Loading models…');
              return;
            }
            if (message.error) {
              console.error('VSLLM Sidebar: Model list error:', message.error);
              if (lastValidModels.length > 0) {
                // Keep the cached list usable and just report that the refresh failed.
                setModelStatus('⚠️ Could not refresh models: ' + message.error);
                return;
              }
              const modelSelect = document.getElementById('model');
              while (modelSelect.firstChild) modelSelect.removeChild(modelSelect.firstChild);
              const opt = document.createElement('option');
              opt.value = '';
              opt.textContent = '❌ Error loading models';
              modelSelect.appendChild(opt);
              setModelStatus('❌ ' + message.error);
              return;
            }
            if (message.models && message.models.length > 0) {
              lastValidModels = message.models;
              renderModels(message.models);
              setModelStatus('✅ ' + message.models.length + ' model(s) available.');
            } else {
              lastValidModels = [];
              const modelSelect = document.getElementById('model');
              while (modelSelect.firstChild) modelSelect.removeChild(modelSelect.firstChild);
              const opt = document.createElement('option');
              opt.value = '';
              opt.textContent = 'No models available';
              modelSelect.appendChild(opt);
              setModelStatus('⚠️ No models found. Please check your VS Code LLM setup.');
            }
          }
        });
        // Tell the extension the script is live. Messages posted before this point can be
        // dropped by VS Code, so the initial model list must be requested from here.
        vscode.postMessage({ command: 'ready' });
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
  private subscribed = false;
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly isServerRunning: () => boolean,
    private readonly catalog: ModelCatalog
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
      serverPhase: server.phase,
      serverDetail: server.detail,
      monitorOpen: MonitorPanel.isOpen(),
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.webviewView = webviewView;
    webviewView.webview.options = { enableScripts: true };
    // Paint synchronously from the cached model list so the panel is usable immediately,
    // then reconcile with a fresh lookup in the background.
    webviewView.webview.html = getConfigWebviewHtml(this.catalog);
    // The model list and toggle state are pushed once the webview reports 'ready':
    // posting them here would race the webview's script and be silently dropped.
    this.postToggleState();
    // Re-sync the switches whenever the view comes back, so they always mirror reality.
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
      if (message.command === 'ready') {
        // The webview is now listening, so it is safe to push state into it.
        this.postToggleState();
        await this.sendModelList();
      } else if (message.command === 'saveConfig') {
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
        await verifyServerAndReportPhase();
      } else if (message.command === 'getModelList') {
        await this.sendModelList();
      }
    });
  }

  /**
   * Immediately echoes the cached list with a "still loading" marker, then posts the
   * authoritative list once the (shared) lookup settles. The GUI stays interactive throughout.
   */
  private async sendModelList() {
    const post = (payload: Record<string, unknown>) => {
      this.webviewView?.webview.postMessage({ command: 'updateModelList', ...payload });
    };
    post({ models: this.catalog.getCached(), loading: true });
    const { models, error } = await this.catalog.refresh();
    if (error) {
      console.error("VSLLM Sidebar: Model list error:", error);
    }
    post(error ? { models, error } : { models });
  }

  refreshWebview() {
    if (this.webviewView) {
      this.webviewView.webview.html = getConfigWebviewHtml(this.catalog);
    }
  }
}
export function activate(context: vscode.ExtensionContext) {
  let serverInstance: any = null;
  let sidebarProviderInstance: VsllmServerSidebarProvider | undefined;
  const modelCatalog = new ModelCatalog(context);

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
    const phase = server.phase ?? (server.running ? "ready" : "stopped");
    const icons: Record<string, string> = {
      stopped: "$(circle-slash)",
      starting: "$(loading~spin)",
      testing: "$(loading~spin)",
      ready: "$(radio-tower)",
      error: "$(error)",
    };
    const colors: Record<string, string | undefined> = {
      starting: "charts.yellow",
      testing: "charts.yellow",
      ready: "charts.green",
      error: "charts.red",
    };
    const color = colors[phase];
    statusItem.color = color ? new vscode.ThemeColor(color) : undefined;
    statusItem.text = `${icons[phase] ?? "$(circle-slash)"} VSLLM ${stats.totalRequests}${stats.activeRequests ? ` (${stats.activeRequests} live)` : ""}${stats.errorRequests ? ` $(error)${stats.errorRequests}` : ""}`;
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
    sidebarProviderInstance = new VsllmServerSidebarProvider(context, () => serverInstance !== null, modelCatalog);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        VsllmServerSidebarProvider.viewType,
        sidebarProviderInstance,
        // Keep the webview alive while hidden so re-opening the sidebar is instant
        // instead of rebuilding it and re-running the model lookup.
        { webviewOptions: { retainContextWhenHidden: true } }
      )
    );
  } catch (err) {
    console.error("VSLLM Server: WebviewViewProvider registration error:", err);
  }
  // Warm the model cache in the background so the first sidebar open already has a list.
  void modelCatalog.refresh();
  console.log("VSLLM Server: Extension activate end");
}
