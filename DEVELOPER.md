# Developer Guide

Internals, build pipeline, and release automation for **VSLLM Server**. For user-facing installation and usage, see [README.md](./README.md).

## Overview

VSLLM Server is a VS Code extension that runs a local HTTP server exposing VS Code's Language Model API (Copilot chat models) behind an OpenAI-compatible interface. Any OpenAI client can point at `http://localhost:<port>/v1` and talk to the models your VS Code session already has access to.

The extension has no backend of its own — it is a translation layer:

```
OpenAI client  ──HTTP──▶  node:http server  ──▶  vscode.lm.selectChatModels()
(curl, SDK,               (src/server.ts)          │
 opencode, …)                   │                  ▼
                                │         model.sendRequest(...)
                                ▼                  │
                         TrafficMonitor            │
                         (src/monitor.ts)          │
                                                   │
       OpenAI-shaped JSON / SSE  ◀────────────────┘
```

Because it relies on `vscode.lm`, the server only works while VS Code is running with an authenticated Copilot session. It cannot run standalone under plain Node.

## Repository layout

```
vsllm_server/
├── .github/workflows/release.yml   # Build, GitHub release, Marketplace publish
├── src/
│   ├── extension.ts                # Activation, commands, sidebar webview, status bar
│   ├── server.ts                   # HTTP server + VS Code LM bridge
│   ├── monitor.ts                  # TrafficMonitor: in-memory request history + stats
│   └── monitorPanel.ts             # Traffic Monitor webview panel
├── resources/vsllm-icon.svg        # Activity bar icon
├── docs/pic/panel.png              # README screenshot
├── esbuild.js                      # Bundler config
├── tsconfig.json                   # Type-check only (noEmit in practice)
├── package.json                    # Extension manifest + scripts
├── .vscodeignore                   # What is excluded from the .vsix
├── test_vsllm.py                   # pytest suite against a running server
├── requirements-dev.txt            # Test dependencies
└── reproduce_issue.js              # Standalone repro for an activation hang
```

### `src/extension.ts`

The extension entry point. Responsibilities:

- **`activate()`** registers the commands, the sidebar webview provider, and the status bar item.
- **`VsllmServerSidebarProvider`** renders the Server Status panel and handles webview messages: `saveConfig`, `startServer`, `stopServer`, `testServer`, `getServerState`, `getModelList`.
- **`getConfigWebviewHtml()`** builds the panel HTML as a template string, interpolating current settings.
- A **traffic-light switch** replaces the old Start/Stop/Test buttons: it is grey while stopped, amber (pulsing) while `starting`/`testing`, green once the automatic self-test passed, and red when startup or the self-test failed. Clicking it starts or stops the server; clicking the status label re-runs the test.
- **`runServerSelfTest()`/`verifyServerAndReportPhase()`** POST a real `hi` chat completion (`max_tokens: 16`, non-streaming) to `/v1/chat/completions` over the configured URL/port right after a successful start, with the API key when one is set and a 45s timeout. The light only turns green when the model actually returns non-empty text, so binding, authorization, the VS Code LM API and response serialization are all covered; the probe shows up in the Traffic Monitor like any other request. A stale result is discarded if the user stops the server while it is in flight.
- A **status bar item** shows live request/error counts from the monitor, colors its icon by server phase, and opens the Traffic Monitor when clicked.

Discovered models are cached in `context.globalState` under `vsllmServer.models` so the panel can render immediately on reopen, then refresh asynchronously.

Registered commands — all declared in `contributes.commands`, so they are reachable from the Command Palette under the **VSLLM Server** category:

| Command ID | Behavior |
| --- | --- |
| `vsllmServer.startServer` | Reads `url`/`host`/`port` from settings, starts the server and self-tests it |
| `vsllmServer.stopServer` | Closes the running server |
| `vsllmServer.restartServer` | Stop (if running) then start and self-test |
| `vsllmServer.selectModel` | Lists available Copilot models in a notification |
| `vsllmServer.openConfigPanel` | Opens Settings filtered to this extension |
| `vsllmServer.openMonitor` | Opens the Traffic Monitor panel |

Settings written from the sidebar go to `ConfigurationTarget.Workspace`, **except `apiKey`**, which is written to `Global` (user) settings and actively removed from workspace settings if found there — this keeps the key out of a committed `.vscode/settings.json`.

### `src/server.ts`

A plain `node:http` server — there is no Express or other framework, despite what the older project summary claims.

- **`readRequestConfig()`** re-reads `apiKey`, `allowedOrigins`, and `maxRequestBytes` **per request**, so changing them takes effect without restarting the server.
- **`assertAuthorized()`** enforces `vsllmServer.apiKey` when one is set, comparing with `timingSafeEquals()` to avoid leaking the key through timing. A blank key leaves the server open.
- **`corsHeadersFor()`** makes CORS **opt-in**: no headers unless the origin is listed in `vsllmServer.allowedOrigins` (or it contains `*`).
- **`readBody()`** streams the request body and rejects anything over `maxRequestBytes` with HTTP 413.
- **`VsCodeLmHandler`** wraps the LM API. `getClient()` calls `vscode.lm.selectChatModels({ vendor: "copilot" })` behind a **10-second timeout guard**, then picks the configured `model` id or falls back to the first available model. An explicitly requested but unknown model returns 404 rather than silently answering with a different one.
- **`extractTextContent()`** accepts both `content: "string"` and the multimodal `content: [{ type: "text", text }]` array form, joining text parts and ignoring images.
- **`convertMessages()`** maps roles onto the LM API. Note that `system` and `user` both become `LanguageModelChatMessage.User` — the LM API has no distinct system role here. Assistant `tool_calls` and `role: "tool"` results are converted into `LanguageModelToolCallPart` / `LanguageModelToolResultPart` rather than being flattened into text.
- **Tool calling** is gated on `vsllmServer.enableToolCalling`. When enabled, OpenAI `tools` are forwarded to the LM API and `tool_calls` come back to the client with `finish_reason: "tool_calls"`; tool names are normalized by `sanitizeToolName()`.
- **`estimateTokens()`** produces approximate `usage` counts — the LM API does not expose real token usage, so these are estimates, not billing-grade numbers.
- **`startVsllmServer()`** creates the server, registers routes, and pushes a disposable onto `context.subscriptions` so the server closes when the extension deactivates. It warns if `host` is non-loopback while no API key is set.

Routes (trailing slashes and query strings are tolerated by `normalizePath()`):

| Method | Path | Notes |
| --- | --- | --- |
| `OPTIONS` | any | CORS preflight, returns `204` |
| `GET` | `/`, `/health`, `/v1` | Status document |
| `GET` | `/v1/models`, `/models` | Lists the real Copilot models available to the session |
| `POST` | `/v1/chat/completions`, `/chat/completions` | Streaming (SSE) when `stream: true`, otherwise a single JSON body |
| any | anything else | `404` JSON error naming the expected routes |

Streaming emits `chat.completion.chunk` events, a final chunk with `finish_reason`, then `data: [DONE]`.

### `src/monitor.ts` and `src/monitorPanel.ts`

`TrafficMonitor` is a singleton that records every request: method, path, remote address, headers, timings, byte counts, streamed chunks, tool activity, warnings, and errors. It keeps a bounded ring of records (`monitorMaxRecords`, clamped to 10–2000), clips captured bodies to `monitorBodyLimit`, and batches change events to the webview instead of firing per mutation.

Bodies are only stored when `monitorCaptureBodies` is on. When `enableLogging` is on, the monitor also mirrors lines to a **VSLLM Server** output channel.

`MonitorPanel` renders the history and handles webview messages: `ready`, `clear`, `pause`, `startServer`, `stopServer`, `export`, and `openSettings`.

## Configuration

Settings live under the `vsllmServer.*` namespace and are declared in `contributes.configuration` in [package.json](./package.json).

| Setting | Default | Notes |
| --- | --- | --- |
| `vsllmServer.url` | `http://localhost` | Advertised base URL |
| `vsllmServer.host` | `127.0.0.1` | Bind address; `0.0.0.0` exposes it on the network |
| `vsllmServer.port` | `8801` | Listen port |
| `vsllmServer.apiKey` | `""` | Machine-scoped. Enforced as a bearer token when non-empty |
| `vsllmServer.allowedOrigins` | `[]` | CORS allowlist; empty sends no CORS headers |
| `vsllmServer.maxRequestBytes` | `1048576` | Bodies above this get HTTP 413 |
| `vsllmServer.enableLogging` | `false` | Enables the monitor's output-channel logging |
| `vsllmServer.maxTokens` | `2048` | Declared but **never read** — see [Known gaps](#known-gaps) |
| `vsllmServer.model` | `""` | Model id to serve; blank picks the first available |
| `vsllmServer.enableToolCalling` | `true` | Forward `tools` and return `tool_calls` |
| `vsllmServer.monitorMaxRecords` | `200` | Monitor history size (clamped 10–2000) |
| `vsllmServer.monitorCaptureBodies` | `true` | Store payloads for inspection |
| `vsllmServer.monitorBodyLimit` | `20000` | Max characters kept per captured body |

## Development setup

### Prerequisites

- Node.js 22 (matching CI; 20+ works locally)
- VS Code 1.85 or newer
- GitHub Copilot installed, signed in, and with chat model consent granted — without it `vscode.lm.selectChatModels` returns nothing

### Install and build

```bash
npm ci            # reproducible install from package-lock.json
npm run compile   # type-check, then bundle to out/extension.js
```

Available scripts:

| Script | What it does |
| --- | --- |
| `npm run check-types` | `tsc --noEmit` — type checking only, emits nothing |
| `npm run compile` | Type-check, then a development bundle (sourcemaps, no minification) |
| `npm run watch` | esbuild watch mode; **skips type checking** |
| `npm run package` | Type-check, then a production bundle (minified, no sourcemaps) |
| `npm run vsix` | Build a `.vsix` via `vsce package --no-dependencies` |

`vscode:prepublish` is wired to `npm run package`, so `vsce` always produces a production bundle.

### Debugging

The repo does not commit a `launch.json`, so pressing <kbd>F5</kbd> will not work out of the box. Create `.vscode/launch.json` with:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/out/**/*.js"],
      "preLaunchTask": "${defaultBuildTask}"
    }
  ]
}
```

Then run `npm run watch` in a terminal and launch. In the Extension Development Host, open the VSLLM Server sidebar and flip the server switch on. Extension logs go to the *Debug Console*; with `enableLogging` on, monitor logs go to the **VSLLM Server** output channel; the panel's own logs appear in the webview devtools (**Developer: Open Webview Developer Tools**).

The Traffic Monitor is usually the fastest way to diagnose a misbehaving client — it shows the exact payload received, what was streamed back, and any warnings raised along the way.

## Build pipeline

Two distinct steps, deliberately separated:

1. **Type checking** — `tsc --noEmit`. Despite `outDir`/`rootDir` in [tsconfig.json](./tsconfig.json), `tsc` never emits; it exists purely to fail the build on type errors.
2. **Bundling** — [esbuild.js](./esbuild.js) bundles `src/extension.ts` into a single CommonJS file at `out/extension.js`, with `vscode` marked external (it is provided by the host at runtime).

`node-fetch` is a runtime dependency but gets **bundled into the output**, which is why packaging with `--no-dependencies` is safe: no `node_modules` needs to ship. If you ever add a dependency that cannot be bundled (native modules, dynamic requires), that flag must be revisited in both `package.json` and the workflow.

[.vscodeignore](./.vscodeignore) keeps the package small — the shipped `.vsix` contains only `package.json`, `readme.md`, `LICENSE.txt`, `vsllmServer.json`, `out/extension.js`, `resources/`, and `docs/pic/`.

## Testing

[test_vsllm.py](./test_vsllm.py) is a pytest suite that exercises a **running** server, so start the extension and start the server from the sidebar first. It skips automatically when nothing is listening rather than failing.

```bash
pip install -r requirements-dev.txt
pytest test_vsllm.py        # assertions
python test_vsllm.py        # verbose manual smoke run
```

It covers the models endpoint, query-string tolerance, unknown-route 404s, streaming and non-streaming completions, and multimodal content parts. Set `VSLLM_BASE_URL` to target a non-default address (default `http://localhost:8801`) and `VSLLM_API_KEY` when an API key is configured.

There is no linter and no unit-test layer; everything else is manual:

```bash
curl http://localhost:8801/v1/models

curl -X POST http://localhost:8801/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

[reproduce_issue.js](./reproduce_issue.js) is a standalone mock of the LM API used to investigate an activation hang; it is a historical debugging aid, not a test.

The most valuable pre-release check is installing the built `.vsix` into a clean VS Code window and confirming the extension activates and the sidebar renders.

## Release automation

[.github/workflows/release.yml](./.github/workflows/release.yml) handles building, GitHub releases, and Marketplace publishing.

### Triggers

- **Tagged push** — any tag matching `v*`.
- **Manual dispatch** — with inputs `release`, `tag`, `prerelease`, and `marketplace`.

`workflow_dispatch` only appears in the Actions UI once the workflow exists on the repository's **default branch**.

### Job: `build`

Runs on every trigger:

1. Checkout, Node 22 with npm cache, `npm ci`.
2. Resolve `version` and the `.vsix` filename from `package.json`, exposed as job outputs.
3. **On tag pushes only**, assert the tag equals `v<version>`. A mismatch fails the run with an explicit error — this prevents shipping a package whose version disagrees with its tag.
4. `npm run check-types`, then `vsce package`.
5. Upload the `.vsix` as a workflow artifact (always).
6. Create the GitHub release, attaching the `.vsix`. If the release already exists, the asset is re-uploaded with `--clobber`, so re-running or moving a tag is idempotent.

Manual runs skip step 6 unless the `release` input is checked.

### Job: `publish`

Publishes to the [VS Code Marketplace](https://marketplace.visualstudio.com/vscode). It **downloads the artifact built by `build`** and publishes that exact file with `--packagePath`, so the Marketplace and the GitHub release are guaranteed to be identical bytes rather than two independent builds. `--skip-duplicate` makes re-runs safe.

Publishing is **opt-in and disabled by default**: the job is skipped unless the repository variable `MARKETPLACE_PUBLISH` is `true`.

Two authentication modes are supported, selected by the `VSCE_AUTH_METHOD` variable:

- **`pat`** (default) — an Azure DevOps token in the `VSCE_PAT` secret.
- **`azure`** — Microsoft Entra ID workload identity federation via `azure/login` and `vsce --azure-credential`, using the job's `id-token: write` permission. Preferred, since Microsoft is phasing out long-lived PATs.

The job runs in a GitHub environment named `marketplace`; adding required reviewers there turns each publish into a manual approval without affecting GitHub releases.

Full setup instructions are in the [README](./README.md#publishing-to-the-vs-code-marketplace).

### Cutting a release

```bash
# 1. Bump the version
#    edit "version" in package.json
npm install --package-lock-only   # keep package-lock.json in sync

# 2. Update the "New in x.y.z" section in README.md

# 3. Verify locally
npm ci && npm run vsix

# 4. Commit, tag, push
git commit -am "Release 0.0.6"
git tag v0.0.6
git push origin main --tags
```

The tag must match `package.json` or CI fails by design. Marketplace versions are immutable — a version can never be re-published, so bump before retrying a bad release.

## Known gaps

Accurate as of version 0.0.5. None of these block normal use, but they are worth knowing before changing related code.

- **`maxTokens` is dead.** Declared in the manifest, never read by `src/`; responses are not capped.
- **`enableLogging` is only half-honoured.** The monitor's output-channel logging respects it, but the `console.log` calls in `src/extension.ts` are unconditional.
- **`vsllmServer.json` is unused and stale.** Nothing in `src/` reads it, it still ships inside the `.vsix`, and its `port` says `8080` while the manifest default is `8801`.
- **No committed `launch.json`.** F5 debugging requires the config above.
- **`VSLLM_SERVER_PROJECT_SUMMARY.md` is stale.** It describes an Express-based server and an unimplemented feature set; neither matches the current code. This guide supersedes it.
- **Token usage is estimated.** `usage` counts come from `estimateTokens()`, not from the LM API.
- **No linter or unit tests.** `test_vsllm.py` needs a live server, so nothing is verified in CI beyond type checking and a successful package.

## References

- [VS Code Extension API](https://code.visualstudio.com/api)
- [Language Model API guide](https://code.visualstudio.com/api/extension-guides/language-model)
- [Extension manifest reference](https://code.visualstudio.com/api/references/extension-manifest)
- [Publishing extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat)
