# Changelog

All notable changes to this project are documented here.

## [0.0.7] - 2026-09-07

### Fixed
- **Auto model tool result continuation**: When using the `"auto"` model selection, the server now automatically appends a prompt after tool results, helping the selected model understand it should continue processing based on the tool's output. This prevents the model from getting stuck when handling tool calls.

## [0.0.6] - 2026-XX-XX

### Added
- **Server status light**: The sidebar **Server** switch is now a traffic light — amber while the server starts, then it automatically sends a real `hi` chat completion through the API and only turns green once the model actually answers, red (with the reason) when it does not. The separate *Test Server* button and its response box are gone.
- **Instant sidebar rendering with background model loading**: The sidebar now displays immediately on startup and fetches available models in the background, making the extension responsive from the start.
- **On/off switches instead of buttons**: The server and traffic monitor controls are now clean toggle switches for better UX.
- **Developer documentation**: New [DEVELOPER.md](./DEVELOPER.md) guide describing project structure, architecture, and internals for contributors.
- **Automated VSIX build and release workflow**: GitHub Actions workflow automates building and publishing releases to GitHub and the VS Code Marketplace.

### Changed
- **Server-controlled model selection**: The `model` field sent by the client is ignored entirely; the extension always uses the model configured in `vsllmServer.model` (or the sidebar selection). Clients can never switch the active model by requesting a different name, even one that VS Code actually offers.

### Removed
- **Redundant `enableLogging` setting**: Simplified configuration by removing the verbose logging toggle (use VS Code's output channel instead).

## [0.0.5] - 2026-XX-XX

### Added
- **Tool / function calling support**: OpenAI `tools` are forwarded to the VS Code Language Model API and `tool_calls` are returned to the client (both streaming and non-streaming), with `finish_reason: "tool_calls"`. This is what agent clients such as **opencode**, Cline, Aider or Continue need in order to actually run tools instead of stopping after the first sentence.
- **Full tool round-trip**: Assistant `tool_calls` and `role: "tool"` results sent back by the client are converted into `LanguageModelToolCallPart` / `LanguageModelToolResultPart` instead of being flattened into text.
- **Traffic Monitor GUI**: A new panel (`VSLLM Server: Open Traffic Monitor`) shows every request in and out — payloads, streamed chunks, tool calls, timings, bytes, warnings and errors.
- **Status bar counter**: Live request/error counts that opens the monitor.
- **Integration tests**: `test_vsllm.py` plus `requirements-dev.txt`.

### Changed
- **Security hardening**: Binds `127.0.0.1` by default, enforces `vsllmServer.apiKey` as a Bearer token, makes CORS opt-in, and caps request bodies. See [Security](./README.md#security).
- **More forgiving routing**: `/chat/completions`, trailing slashes and query strings are accepted, `/health` returns a status document, and `/v1/models` now lists the real Copilot models.
- **Correct model selection**: An explicitly requested `model` is honoured, and an unknown one returns 404 instead of silently answering with a different model.
- **Better diagnostics**: Port conflicts, invalid JSON, unsupported content parts, empty model responses and unknown routes are surfaced instead of failing silently.
- **API key handling**: `vsllmServer.apiKey` is machine-scoped, so it can no longer be written into a committed `.vscode/settings.json`.

### Fixed
- **Packaging fix**: The manifest was missing a `publisher`, so the VSIX installed as `undefined_publisher.vsllm-server` next to any existing install instead of replacing it, leaving two copies racing for the port.

## [0.0.3] - 2026-XX-XX

### Added
- **Full OpenAI API compatibility**: Now works with clients like qwen-code, Continue, and other OpenAI-compatible tools
- **Streaming support**: Added Server-Sent Events (SSE) streaming for `stream: true` requests
- **Flexible message content formats**: Supports both string content and array content formats (multimodal-style)
- **New `/v1/models` endpoint**: List available models via GET request
- **CORS support**: Cross-origin requests are now supported

### Changed
- **Improved error handling**: Better error responses following OpenAI API error format

## [0.0.2] - 2026-XX-XX

### Added
- Modern esbuild build pipeline for faster, reliable TypeScript builds
- Enhanced sidebar UI and logging, especially for model selection
- Initial VS Code settings configuration

### Changed
- Extension and server configuration now fully align with VS Code settings (model, URL, port, etc.)
- Improved sidebar panel and webview styling

### Updated
- Dependency and script updates for easier development

## [0.0.1] - 2026-XX-XX

### Changed
- Commands are no longer available in the Command Palette
- Access all server controls and configuration via the VSLLM Server sidebar icon
