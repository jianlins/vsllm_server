// VSLLM Server: webview GUI that visualizes live traffic captured by the TrafficMonitor.

import * as vscode from "vscode";
import { monitor, MonitorEvent } from "./monitor";

function nonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export class MonitorPanel {
  public static readonly viewType = "vsllmServer.monitor";
  private static current: MonitorPanel | undefined;
  private static readonly stateEmitter = new vscode.EventEmitter<boolean>();
  /** Fires with the new open/closed state, including when the user closes the tab manually. */
  public static readonly onDidChangeState = MonitorPanel.stateEmitter.event;

  static isOpen(): boolean {
    return MonitorPanel.current !== undefined;
  }

  static close() {
    MonitorPanel.current?.dispose();
  }

  static show(context: vscode.ExtensionContext) {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (MonitorPanel.current) {
      MonitorPanel.current.panel.reveal(column);
      return MonitorPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      MonitorPanel.viewType,
      "VSLLM Traffic Monitor",
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    MonitorPanel.current = new MonitorPanel(panel, context);
    MonitorPanel.stateEmitter.fire(true);
    return MonitorPanel.current;
  }

  private disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext
  ) {
    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.disposables.push(
      monitor.onDidChange((event: MonitorEvent) => {
        this.panel.webview.postMessage(event);
      })
    );

    this.panel.webview.onDidReceiveMessage(
      async (message) => this.handleMessage(message),
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  private async handleMessage(message: any) {
    switch (message?.command) {
      case "ready": {
        const snapshot = monitor.getSnapshot();
        this.panel.webview.postMessage({ type: "snapshot", ...snapshot, paused: monitor.isPaused() });
        break;
      }
      case "clear":
        monitor.clear();
        break;
      case "pause":
        monitor.setPaused(!!message.paused);
        break;
      case "setServer":
        await vscode.commands.executeCommand("vsllmServer.toggleServer", !!message.running);
        // Re-sync even when nothing changed (e.g. a failed start) so the switch cannot get stuck.
        this.panel.webview.postMessage({ type: "server", server: monitor.getSnapshot().server });
        break;
      case "export": {
        const snapshot = monitor.getSnapshot();
        const target = await vscode.window.showSaveDialog({
          filters: { JSON: ["json"] },
          saveLabel: "Export traffic log",
          defaultUri: vscode.Uri.file(`vsllm-traffic-${Date.now()}.json`),
        });
        if (target) {
          await vscode.workspace.fs.writeFile(
            target,
            Buffer.from(JSON.stringify(snapshot, null, 2), "utf8")
          );
          vscode.window.showInformationMessage(`Exported ${snapshot.records.length} requests to ${target.fsPath}`);
        }
        break;
      }
      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "vsllmServer");
        break;
    }
  }

  dispose() {
    if (MonitorPanel.current !== this) {
      return;
    }
    MonitorPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    MonitorPanel.stateEmitter.fire(false);
  }

  private getHtml(webview: vscode.Webview): string {
    return getMonitorHtml(webview.cspSource);
  }
}

export function getMonitorHtml(cspSource: string): string {
  {
    const n = nonce();
    const csp = [
      "default-src 'none'",
      `style-src ${cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${n}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VSLLM Traffic Monitor</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    height: 100vh; display: flex; flex-direction: column; overflow: hidden;
  }
  .toolbar {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border);
  }
  button {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #fff);
    border: none; border-radius: 3px; padding: 4px 10px; cursor: pointer; font-size: 12px;
  }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { filter: brightness(1.15); }
  input[type=search], input[type=text] {
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 4px 8px; min-width: 180px;
  }
  label.check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; opacity: .85; }
  .pill { border-radius: 10px; padding: 1px 8px; font-size: 11px; font-weight: 600; white-space: nowrap; }
  .pill.on { background: #1f7a1f; color: #fff; }
  .pill.off { background: #7a1f1f; color: #fff; }
  .pill.pending { background: #8a6d00; color: #fff; }
  .switch { position: relative; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; }
  .switch input { position: absolute; opacity: 0; width: 0; height: 0; }
  .switch .track {
    display: inline-block; position: relative; width: 32px; height: 17px; border-radius: 9px;
    background: var(--vscode-checkbox-background, #6b6b6b);
    border: 1px solid var(--vscode-checkbox-border, #8a8a8a);
    transition: background .15s ease;
  }
  .switch .thumb {
    position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%;
    background: var(--vscode-foreground, #ddd); transition: transform .15s ease;
  }
  .switch input:checked + .track { background: #2ea043; border-color: #2ea043; }
  .switch input:checked + .track .thumb { transform: translateX(15px); background: #fff; }
  /* Traffic light: amber while the server is starting or being tested, red when it failed. */
  .switch.pending input + .track, .switch.pending input:checked + .track { background: #8a6d00; border-color: #8a6d00; }
  .switch.failed input + .track, .switch.failed input:checked + .track { background: #a31515; border-color: #a31515; }
  .switch input:focus-visible + .track { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .switch input:disabled + .track { opacity: .5; }
  .switch input:disabled { cursor: progress; }
  .stats { display: flex; gap: 14px; flex-wrap: wrap; padding: 6px 12px; font-size: 11.5px;
           border-bottom: 1px solid var(--vscode-panel-border); opacity: .9; }
  .stats b { font-weight: 600; }
  .split { flex: 1; display: flex; min-height: 0; }
  .list { width: 46%; min-width: 320px; overflow: auto; border-right: 1px solid var(--vscode-panel-border); }
  .detail { flex: 1; overflow: auto; padding: 10px 14px; min-width: 0; }
  .row {
    padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; font-size: 12px;
  }
  .rowhead { display: grid; grid-template-columns: 38px 74px minmax(0, 1fr) auto; gap: 6px; align-items: center; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .row .seq { opacity: .55; font-variant-numeric: tabular-nums; }
  .row .time { opacity: .7; font-variant-numeric: tabular-nums; }
  .row .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .meta { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; margin-top: 4px; padding-left: 44px; }
  .badge { font-size: 10px; padding: 0 5px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; }
  .badge.warn { background: #a37500; color: #fff; }
  .badge.err { background: #a31515; color: #fff; }
  .badge.ok { background: #2d7d2d; color: #fff; }
  .badge.live { background: #1f6feb; color: #fff; }
  .badge.tool { background: #6f42c1; color: #fff; }
  h3 { margin: 12px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; opacity: .75; }
  h2 { margin: 0 0 4px; font-size: 15px; }
  pre {
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.12));
    padding: 8px; border-radius: 4px; overflow: auto; max-height: 420px;
    font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre-wrap; word-break: break-word;
  }
  table.kv { border-collapse: collapse; font-size: 12px; }
  table.kv td { padding: 2px 12px 2px 0; vertical-align: top; }
  table.kv td.k { opacity: .65; white-space: nowrap; }
  .warnbox { border-left: 3px solid #a37500; background: rgba(163,117,0,.12); padding: 6px 10px; margin: 6px 0; font-size: 12px; }
  .errbox { border-left: 3px solid #a31515; background: rgba(163,21,21,.12); padding: 6px 10px; margin: 6px 0; font-size: 12px; }
  .tl { font-size: 11.5px; font-family: var(--vscode-editor-font-family); }
  .tl div { padding: 1px 0; }
  .tl .t { opacity: .55; display: inline-block; width: 74px; }
  .empty { padding: 24px; opacity: .6; font-size: 13px; text-align: center; }
  .tabs { display: flex; gap: 4px; margin-top: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  .tabs button { border-radius: 3px 3px 0 0; background: transparent; opacity: .7; }
  .tabs button.active { background: var(--vscode-tab-activeBackground, rgba(127,127,127,.2)); opacity: 1; border-bottom: 2px solid var(--vscode-focusBorder); }
</style>
</head>
<body>
  <div class="toolbar">
    <label class="switch" title="Turn the VSLLM server on or off">
      <input type="checkbox" id="serverSwitch" />
      <span class="track"><span class="thumb"></span></span>
      <span>Server</span>
    </label>
    <span id="serverPill" class="pill off">server: unknown</span>
    <span style="width:8px"></span>
    <button id="pauseBtn">Pause</button>
    <button id="clearBtn">Clear</button>
    <button id="exportBtn">Export JSON</button>
    <button id="settingsBtn">Settings</button>
    <input id="filter" type="search" placeholder="Filter path, body, tool, error..." />
    <label class="check"><input type="checkbox" id="errorsOnly" /> problems only</label>
    <label class="check"><input type="checkbox" id="follow" checked /> follow latest</label>
  </div>
  <div class="stats" id="stats"></div>
  <div class="split">
    <div class="list" id="list"></div>
    <div class="detail" id="detail"><div class="empty">Select a request to inspect the exchanged data.</div></div>
  </div>

<script nonce="${n}">
(function () {
  const vscodeApi = acquireVsCodeApi();
  const state = {
    records: new Map(),
    order: [],
    selected: null,
    follow: true,
    filter: "",
    errorsOnly: false,
    paused: false,
    stats: null,
    server: null
  };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined && text !== null) { node.textContent = String(text); }
    return node;
  };

  function fmtBytes(bytes) {
    if (!bytes) { return "0 B"; }
    if (bytes < 1024) { return bytes + " B"; }
    if (bytes < 1024 * 1024) { return (bytes / 1024).toFixed(1) + " KB"; }
    return (bytes / 1024 / 1024).toFixed(2) + " MB";
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    const pad = (v, n) => String(v).padStart(n || 2, "0");
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + "." + pad(d.getMilliseconds(), 3);
  }
  function fmtDur(ms) {
    if (ms === undefined || ms === null) { return "-"; }
    return ms < 1000 ? ms + " ms" : (ms / 1000).toFixed(2) + " s";
  }
  function pretty(text) {
    if (!text) { return ""; }
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { return text; }
  }

  function matchesFilter(rec) {
    if (state.errorsOnly && !(rec.error || rec.warnings.length || (rec.status && rec.status >= 400))) { return false; }
    if (!state.filter) { return true; }
    const needle = state.filter.toLowerCase();
    const hay = [
      rec.path, rec.query, rec.method, rec.userAgent, rec.remote,
      rec.modelRequested, rec.modelResolved, rec.error, rec.finishReason,
      (rec.toolNames || []).join(" "),
      (rec.toolCalls || []).map(c => c.name + " " + c.args).join(" "),
      (rec.warnings || []).join(" "),
      rec.requestBody, rec.responseText, rec.responseBody
    ].filter(Boolean).join(" ").toLowerCase();
    return hay.indexOf(needle) !== -1;
  }

  let renderQueued = false;
  function queueRender() {
    if (renderQueued) { return; }
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderList(); renderDetail(); renderStats(); });
  }

  function renderStats() {
    const s = state.stats;
    const box = document.getElementById("stats");
    box.textContent = "";
    if (!s) { return; }
    const items = [
      ["requests", s.totalRequests],
      ["in flight", s.activeRequests],
      ["errors", s.errorRequests],
      ["data in", fmtBytes(s.bytesIn)],
      ["data out", fmtBytes(s.bytesOut)],
      ["tools offered", s.toolsOffered],
      ["tool calls returned", s.toolCallsEmitted],
      ["avg latency", fmtDur(s.avgDurationMs)],
      ["last activity", s.lastActivity ? fmtTime(s.lastActivity) : "-"]
    ];
    items.forEach(([k, v]) => {
      const span = el("span");
      span.appendChild(el("span", null, k + ": "));
      span.appendChild(el("b", null, v));
      box.appendChild(span);
    });
  }

  function renderServer() {
    const pill = document.getElementById("serverPill");
    const sw = document.getElementById("serverSwitch");
    const srv = state.server;
    if (!srv) { pill.textContent = "server: unknown"; pill.className = "pill off"; return; }
    const phase = srv.phase || (srv.running ? "ready" : "stopped");
    const endpoint = srv.url + ":" + srv.port;
    const busy = phase === "starting" || phase === "testing";
    if (busy) {
      pill.textContent = (phase === "starting" ? "starting " : "testing ") + endpoint;
      pill.className = "pill pending";
    } else if (phase === "error") {
      pill.textContent = "server error" + (srv.detail ? ": " + srv.detail : "");
      pill.className = "pill off";
    } else if (phase === "ready" || srv.running) {
      pill.textContent = "listening " + endpoint;
      pill.className = "pill on";
    } else {
      pill.textContent = "server stopped";
      pill.className = "pill off";
    }
    pill.title = srv.detail || "";
    sw.checked = !!srv.running || busy;
    sw.disabled = phase === "starting";
    sw.parentElement.className = "switch" + (busy ? " pending" : phase === "error" ? " failed" : "");
  }

  function statusBadge(rec) {
    if (rec.state === "active") { return el("span", "badge live", "live"); }
    if (rec.error || (rec.status && rec.status >= 400)) { return el("span", "badge err", String(rec.status || "err")); }
    return el("span", "badge ok", String(rec.status || 200));
  }

  function renderList() {
    const list = document.getElementById("list");
    const visible = state.order.map(id => state.records.get(id)).filter(r => r && matchesFilter(r));
    list.textContent = "";
    if (visible.length === 0) {
      list.appendChild(el("div", "empty", "No traffic captured yet. Point your client at the server and send a request."));
      return;
    }
    visible.forEach(rec => {
      const row = el("div", "row" + (state.selected === rec.id ? " selected" : ""));
      const head = el("div", "rowhead");
      head.appendChild(el("div", "seq", "#" + rec.seq));
      head.appendChild(el("div", "time", fmtTime(rec.startedAt)));
      const path = el("div", "path", rec.method + " " + rec.path + (rec.query || ""));
      path.title = rec.method + " " + rec.path + (rec.query || "");
      head.appendChild(path);
      head.appendChild(statusBadge(rec));
      row.appendChild(head);
      const meta = el("div", "meta");
      if (rec.stream) { meta.appendChild(el("span", "badge", "stream")); }
      if (rec.toolNames && rec.toolNames.length) { meta.appendChild(el("span", "badge tool", rec.toolNames.length + " tools")); }
      if (rec.toolCalls && rec.toolCalls.length) { meta.appendChild(el("span", "badge tool", rec.toolCalls.length + " calls")); }
      if (rec.warnings && rec.warnings.length) { meta.appendChild(el("span", "badge warn", "\\u26a0 " + rec.warnings.length)); }
      meta.appendChild(el("span", "badge", "\\u2193" + fmtBytes(rec.requestBytes)));
      meta.appendChild(el("span", "badge", "\\u2191" + fmtBytes(rec.responseBytes)));
      meta.appendChild(el("span", "badge", fmtDur(rec.durationMs)));
      if (rec.finishReason) { meta.appendChild(el("span", "badge", rec.finishReason)); }
      row.appendChild(meta);
      row.addEventListener("click", () => {
        state.selected = rec.id;
        state.follow = false;
        document.getElementById("follow").checked = false;
        queueRender();
      });
      list.appendChild(row);
    });
  }

  function kv(rows) {
    const table = el("table", "kv");
    rows.forEach(([k, v]) => {
      if (v === undefined || v === null || v === "") { return; }
      const tr = el("tr");
      tr.appendChild(el("td", "k", k));
      tr.appendChild(el("td", null, v));
      table.appendChild(tr);
    });
    return table;
  }

  function section(parent, title, node) {
    parent.appendChild(el("h3", null, title));
    parent.appendChild(node);
  }

  function renderDetail() {
    const detail = document.getElementById("detail");
    const rec = state.selected ? state.records.get(state.selected) : null;
    const scrollTop = detail.scrollTop;
    detail.textContent = "";
    if (!rec) {
      detail.appendChild(el("div", "empty", "Select a request to inspect the exchanged data."));
      return;
    }

    detail.appendChild(el("h2", null, "#" + rec.seq + "  " + rec.method + " " + rec.path + (rec.query || "")));

    (rec.warnings || []).forEach(w => detail.appendChild(el("div", "warnbox", "\\u26a0 " + w)));
    if (rec.error) { detail.appendChild(el("div", "errbox", "\\u2716 " + rec.error)); }

    section(detail, "overview", kv([
      ["state", rec.state + (rec.status ? " (" + rec.status + ")" : "")],
      ["client", rec.remote + (rec.userAgent ? "  \\u2022  " + rec.userAgent : "")],
      ["started", new Date(rec.startedAt).toLocaleString()],
      ["duration", fmtDur(rec.durationMs)],
      ["time to first token", rec.ttfbMs === undefined ? "-" : fmtDur(rec.ttfbMs)],
      ["stream", String(rec.stream)],
      ["model requested", rec.modelRequested || "(none)"],
      ["model used", rec.modelResolved || "(not resolved)"],
      ["messages", rec.messageCount + (rec.messageRoles.length ? "  [" + rec.messageRoles.join(", ") + "]" : "")],
      ["prompt characters", rec.promptChars],
      ["tools offered by client", rec.toolNames.length ? rec.toolNames.join(", ") : "(none)"],
      ["tool_choice", rec.toolChoice],
      ["tool calls returned", rec.toolCalls.length],
      ["finish reason", rec.finishReason || "-"],
      ["bytes in / out", fmtBytes(rec.requestBytes) + " / " + fmtBytes(rec.responseBytes)],
      ["stream chunks", rec.chunkCount]
    ]));

    if (rec.toolCalls && rec.toolCalls.length) {
      const pre = el("pre", null, rec.toolCalls.map(c => c.name + "(" + c.args + ")   [id " + c.id + "]").join("\\n"));
      section(detail, "tool calls returned to client", pre);
    }

    section(detail, "request headers", el("pre", null,
      Object.keys(rec.requestHeaders || {}).map(k => k + ": " + rec.requestHeaders[k]).join("\\n") || "(none)"));

    section(detail, "request body" + (rec.requestTruncated ? " (truncated)" : ""),
      el("pre", null, pretty(rec.requestBody) || "(not captured)"));

    if (rec.responseText) {
      section(detail, "model text" + (rec.responseTruncated ? " (truncated)" : ""), el("pre", null, rec.responseText));
    }
    if (rec.responseBody) {
      section(detail, "response body", el("pre", null, pretty(rec.responseBody)));
    }

    const tl = el("div", "tl");
    (rec.timeline || []).forEach(entry => {
      const line = el("div");
      line.appendChild(el("span", "t", "+" + (entry.t - rec.startedAt) + "ms"));
      line.appendChild(el("span", null, entry.kind + (entry.detail ? ": " + entry.detail : "")));
      tl.appendChild(line);
    });
    section(detail, "timeline", tl);
    detail.scrollTop = scrollTop;
  }

  function upsert(records) {
    records.forEach(rec => {
      if (!state.records.has(rec.id)) { state.order.push(rec.id); }
      state.records.set(rec.id, rec);
    });
    // Drop ids that aged out of the extension-side ring buffer.
    if (state.order.length > 2000) { state.order = state.order.slice(-2000); }
    if (state.follow && records.length) { state.selected = records[records.length - 1].id; }
    queueRender();
  }

  window.addEventListener("message", event => {
    const msg = event.data;
    if (!msg) { return; }
    if (msg.type === "snapshot") {
      state.records = new Map();
      state.order = [];
      (msg.records || []).forEach(r => { state.records.set(r.id, r); state.order.push(r.id); });
      state.stats = msg.stats;
      state.server = msg.server;
      state.paused = !!msg.paused;
      document.getElementById("pauseBtn").textContent = state.paused ? "Resume" : "Pause";
      if (!state.selected && state.order.length) { state.selected = state.order[state.order.length - 1]; }
      renderServer();
      queueRender();
    } else if (msg.type === "upsert") {
      if (state.paused) { return; }
      state.stats = msg.stats;
      upsert(msg.records || []);
    } else if (msg.type === "cleared") {
      state.records = new Map();
      state.order = [];
      state.selected = null;
      state.stats = msg.stats;
      queueRender();
    } else if (msg.type === "server") {
      state.server = msg.server;
      renderServer();
    }
  });

  document.getElementById("clearBtn").addEventListener("click", () => vscodeApi.postMessage({ command: "clear" }));
  document.getElementById("exportBtn").addEventListener("click", () => vscodeApi.postMessage({ command: "export" }));
  document.getElementById("settingsBtn").addEventListener("click", () => vscodeApi.postMessage({ command: "openSettings" }));
  document.getElementById("serverSwitch").addEventListener("change", function () {
    const pill = document.getElementById("serverPill");
    pill.textContent = this.checked ? "starting..." : "stopping...";
    pill.className = "pill pending";
    this.parentElement.className = "switch pending";
    this.disabled = true;
    vscodeApi.postMessage({ command: "setServer", running: this.checked });
  });
  document.getElementById("pauseBtn").addEventListener("click", () => {
    state.paused = !state.paused;
    document.getElementById("pauseBtn").textContent = state.paused ? "Resume" : "Pause";
    vscodeApi.postMessage({ command: "pause", paused: state.paused });
    if (!state.paused) { vscodeApi.postMessage({ command: "ready" }); }
  });
  document.getElementById("filter").addEventListener("input", e => { state.filter = e.target.value.trim(); queueRender(); });
  document.getElementById("errorsOnly").addEventListener("change", e => { state.errorsOnly = e.target.checked; queueRender(); });
  document.getElementById("follow").addEventListener("change", e => { state.follow = e.target.checked; queueRender(); });

  vscodeApi.postMessage({ command: "ready" });
})();
</script>
</body>
</html>`;
  }
}
