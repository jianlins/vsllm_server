// VSLLM Server: in-memory traffic monitor shared by the HTTP server and the monitor GUI.

import * as vscode from "vscode";

export interface TimelineEntry {
  t: number;
  kind: string;
  detail?: string;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  args: string;
}

export type TrafficState = "active" | "done" | "error";

export interface TrafficRecord {
  id: string;
  seq: number;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  ttfbMs?: number;
  method: string;
  path: string;
  query: string;
  remote: string;
  userAgent: string;
  requestHeaders: Record<string, string>;
  requestBytes: number;
  requestBody?: string;
  requestTruncated: boolean;
  stream: boolean;
  modelRequested?: string;
  modelResolved?: string;
  messageCount: number;
  messageRoles: string[];
  promptChars: number;
  toolNames: string[];
  toolChoice?: string;
  status?: number;
  responseBytes: number;
  chunkCount: number;
  responseText: string;
  responseTruncated: boolean;
  responseBody?: string;
  toolCalls: ToolCallRecord[];
  finishReason?: string;
  error?: string;
  warnings: string[];
  timeline: TimelineEntry[];
  state: TrafficState;
}

export interface MonitorStats {
  totalRequests: number;
  activeRequests: number;
  completedRequests: number;
  errorRequests: number;
  bytesIn: number;
  bytesOut: number;
  toolCallsEmitted: number;
  toolsOffered: number;
  avgDurationMs: number;
  lastActivity?: number;
}

/**
 * Lifecycle of the local HTTP server as shown by the traffic-light switch in the sidebar:
 * grey `stopped`, amber `starting`/`testing`, green `ready` (self-test passed), red `error`.
 */
export type ServerPhase = "stopped" | "starting" | "testing" | "ready" | "error";

export interface ServerState {
  running: boolean;
  url: string;
  port: number;
  startedAt?: number;
  phase: ServerPhase;
  detail?: string;
}

export type MonitorEvent =
  | { type: "upsert"; records: TrafficRecord[]; stats: MonitorStats }
  | { type: "cleared"; stats: MonitorStats }
  | { type: "server"; server: ServerState };

const FLUSH_INTERVAL_MS = 120;

function clip(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, limit), truncated: true };
}

/**
 * Collects every byte that flows in and out of the OpenAI-compatible endpoints so the
 * monitor webview can replay exactly what a client (opencode, Cline, curl, ...) exchanged.
 */
export class TrafficMonitor {
  private static _instance: TrafficMonitor | undefined;

  static get instance(): TrafficMonitor {
    if (!TrafficMonitor._instance) {
      TrafficMonitor._instance = new TrafficMonitor();
    }
    return TrafficMonitor._instance;
  }

  private readonly emitter = new vscode.EventEmitter<MonitorEvent>();
  readonly onDidChange = this.emitter.event;

  private records: TrafficRecord[] = [];
  private byId = new Map<string, TrafficRecord>();
  private dirty = new Set<string>();
  private flushTimer: NodeJS.Timeout | undefined;
  private seq = 0;
  private output: vscode.OutputChannel | undefined;
  private paused = false;

  private stats: MonitorStats = {
    totalRequests: 0,
    activeRequests: 0,
    completedRequests: 0,
    errorRequests: 0,
    bytesIn: 0,
    bytesOut: 0,
    toolCallsEmitted: 0,
    toolsOffered: 0,
    avgDurationMs: 0,
  };
  private durationSum = 0;

  private server: ServerState = { running: false, url: "http://localhost", port: 8080, phase: "stopped" };

  private get maxRecords(): number {
    const value = vscode.workspace.getConfiguration("vsllmServer").get<number>("monitorMaxRecords", 200);
    return Math.max(10, Math.min(2000, value || 200));
  }

  private get bodyLimit(): number {
    const value = vscode.workspace.getConfiguration("vsllmServer").get<number>("monitorBodyLimit", 20000);
    return Math.max(500, value || 20000);
  }

  private get captureBodies(): boolean {
    return vscode.workspace.getConfiguration("vsllmServer").get<boolean>("monitorCaptureBodies", true);
  }

  private get loggingEnabled(): boolean {
    return vscode.workspace.getConfiguration("vsllmServer").get<boolean>("enableLogging", false);
  }

  private log(line: string) {
    if (!this.loggingEnabled) {
      return;
    }
    if (!this.output) {
      this.output = vscode.window.createOutputChannel("VSLLM Server");
    }
    this.output.appendLine(`[${new Date().toISOString()}] ${line}`);
  }

  getSnapshot(): { records: TrafficRecord[]; stats: MonitorStats; server: ServerState } {
    return { records: [...this.records], stats: { ...this.stats }, server: { ...this.server } };
  }

  setPaused(paused: boolean) {
    this.paused = paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setServerState(state: Partial<ServerState>) {
    this.server = { ...this.server, ...state };
    this.emitter.fire({ type: "server", server: { ...this.server } });
  }

  /** Moves the traffic light to a new phase; `detail` carries the reason shown under the switch. */
  setServerPhase(phase: ServerPhase, detail?: string) {
    this.setServerState({ phase, detail });
  }

  getServerState(): ServerState {
    return { ...this.server };
  }

  clear() {
    this.records = [];
    this.byId.clear();
    this.dirty.clear();
    this.durationSum = 0;
    this.stats = {
      totalRequests: 0,
      activeRequests: 0,
      completedRequests: 0,
      errorRequests: 0,
      bytesIn: 0,
      bytesOut: 0,
      toolCallsEmitted: 0,
      toolsOffered: 0,
      avgDurationMs: 0,
    };
    this.emitter.fire({ type: "cleared", stats: { ...this.stats } });
  }

  begin(init: {
    method: string;
    path: string;
    query: string;
    remote: string;
    headers: Record<string, string>;
  }): TrafficRecord {
    const record: TrafficRecord = {
      id: `${Date.now().toString(36)}-${(this.seq + 1).toString(36)}`,
      seq: ++this.seq,
      startedAt: Date.now(),
      method: init.method,
      path: init.path,
      query: init.query,
      remote: init.remote,
      userAgent: init.headers["user-agent"] || "",
      requestHeaders: init.headers,
      requestBytes: 0,
      requestTruncated: false,
      stream: false,
      messageCount: 0,
      messageRoles: [],
      promptChars: 0,
      toolNames: [],
      responseBytes: 0,
      chunkCount: 0,
      responseText: "",
      responseTruncated: false,
      toolCalls: [],
      warnings: [],
      timeline: [{ t: Date.now(), kind: "request", detail: `${init.method} ${init.path}${init.query}` }],
      state: "active",
    };

    this.records.push(record);
    this.byId.set(record.id, record);
    while (this.records.length > this.maxRecords) {
      const dropped = this.records.shift();
      if (dropped) {
        this.byId.delete(dropped.id);
      }
    }

    this.stats.totalRequests++;
    this.stats.activeRequests++;
    this.stats.lastActivity = record.startedAt;
    this.log(`--> #${record.seq} ${init.method} ${init.path}${init.query} from ${init.remote} (${record.userAgent})`);
    this.markDirty(record);
    return record;
  }

  setRequestBody(record: TrafficRecord, raw: string) {
    record.requestBytes = Buffer.byteLength(raw, "utf8");
    this.stats.bytesIn += record.requestBytes;
    if (this.captureBodies) {
      const clipped = clip(raw, this.bodyLimit);
      record.requestBody = clipped.text;
      record.requestTruncated = clipped.truncated;
    }
    this.event(record, "body-received", `${record.requestBytes} bytes`);
  }

  describePayload(
    record: TrafficRecord,
    info: {
      stream: boolean;
      modelRequested?: string;
      messages: Array<{ role?: string; content?: unknown }>;
      toolNames: string[];
      toolChoice?: string;
      promptChars: number;
    }
  ) {
    record.stream = info.stream;
    record.modelRequested = info.modelRequested;
    record.messageCount = info.messages.length;
    record.messageRoles = info.messages.map((m) => String(m.role ?? "?"));
    record.toolNames = info.toolNames;
    record.toolChoice = info.toolChoice;
    record.promptChars = info.promptChars;
    this.stats.toolsOffered += info.toolNames.length;
    this.event(
      record,
      "payload",
      `${info.messages.length} messages, ${info.toolNames.length} tools, stream=${info.stream}`
    );
  }

  setResolvedModel(record: TrafficRecord, modelId: string) {
    record.modelResolved = modelId;
    this.event(record, "model", modelId);
  }

  appendText(record: TrafficRecord, text: string) {
    record.chunkCount++;
    if (record.ttfbMs === undefined) {
      record.ttfbMs = Date.now() - record.startedAt;
      this.event(record, "first-token", `${record.ttfbMs} ms`);
    }
    if (this.captureBodies && !record.responseTruncated) {
      const combined = record.responseText + text;
      const clipped = clip(combined, this.bodyLimit);
      record.responseText = clipped.text;
      record.responseTruncated = clipped.truncated;
    }
    this.markDirty(record);
  }

  addToolCall(record: TrafficRecord, call: ToolCallRecord) {
    record.toolCalls.push(call);
    this.stats.toolCallsEmitted++;
    if (record.ttfbMs === undefined) {
      record.ttfbMs = Date.now() - record.startedAt;
    }
    this.event(record, "tool-call", `${call.name} ${call.args}`);
  }

  addBytesOut(record: TrafficRecord, bytes: number) {
    record.responseBytes += bytes;
    this.stats.bytesOut += bytes;
    this.markDirty(record);
  }

  setResponseBody(record: TrafficRecord, raw: string) {
    if (this.captureBodies) {
      const clipped = clip(raw, this.bodyLimit);
      record.responseBody = clipped.text;
      record.responseTruncated = record.responseTruncated || clipped.truncated;
    }
  }

  warn(record: TrafficRecord, message: string) {
    if (!record.warnings.includes(message)) {
      record.warnings.push(message);
      this.event(record, "warning", message);
    }
  }

  event(record: TrafficRecord, kind: string, detail?: string) {
    record.timeline.push({ t: Date.now(), kind, detail });
    this.log(`    #${record.seq} ${kind}${detail ? `: ${detail}` : ""}`);
    this.markDirty(record);
  }

  finish(record: TrafficRecord, status: number, finishReason?: string) {
    if (record.state !== "active") {
      return;
    }
    record.state = status >= 400 ? "error" : "done";
    record.status = status;
    record.finishReason = finishReason;
    record.endedAt = Date.now();
    record.durationMs = record.endedAt - record.startedAt;
    this.stats.activeRequests = Math.max(0, this.stats.activeRequests - 1);
    this.stats.completedRequests++;
    if (record.state === "error") {
      this.stats.errorRequests++;
    }
    this.durationSum += record.durationMs;
    this.stats.avgDurationMs = Math.round(this.durationSum / Math.max(1, this.stats.completedRequests));
    this.stats.lastActivity = record.endedAt;
    this.log(
      `<-- #${record.seq} ${status} in ${record.durationMs}ms, ${record.responseBytes} bytes, ` +
        `${record.chunkCount} chunks, ${record.toolCalls.length} tool calls, finish=${finishReason ?? "n/a"}`
    );
    this.markDirty(record, true);
  }

  fail(record: TrafficRecord, error: unknown, status = 500) {
    record.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    this.event(record, "error", record.error);
    if (record.state === "active") {
      this.finish(record, status);
    } else {
      this.markDirty(record, true);
    }
  }

  private markDirty(record: TrafficRecord, immediate = false) {
    this.dirty.add(record.id);
    if (immediate) {
      this.flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  private flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.dirty.size === 0) {
      return;
    }
    const records: TrafficRecord[] = [];
    for (const id of this.dirty) {
      const record = this.byId.get(id);
      if (record) {
        records.push(record);
      }
    }
    this.dirty.clear();
    if (records.length > 0) {
      this.emitter.fire({ type: "upsert", records, stats: { ...this.stats } });
    }
  }

  dispose() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.emitter.dispose();
    this.output?.dispose();
  }
}

export const monitor = TrafficMonitor.instance;
