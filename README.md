# VSCode LLM Server

Expose VSCode chat models as an OpenAI-compatible API endpoint. This extension provides a local HTTP server with a `/v1/chat/completions` endpoint, powered by VS Code's Language Model API.


## New in 0.0.4
- **Automated releases**: GitHub Actions workflow builds the `.vsix` and publishes it to GitHub Releases on tagged pushes or manual runs
- **Proper extension identity**: added the missing `publisher` field, so packaged VSIX files are no longer marked with an `undefined` publisher
- **Leaner package**: the VSIX now ships the LICENSE and excludes build/dev-only files

## New in 0.0.3
- **Full OpenAI API compatibility**: Now works with clients like qwen-code, Continue, and other OpenAI-compatible tools
- **Streaming support**: Added Server-Sent Events (SSE) streaming for `stream: true` requests
- **Flexible message content formats**: Supports both string content and array content formats (multimodal-style)
- **New `/v1/models` endpoint**: List available models via GET request
- **CORS support**: Cross-origin requests are now supported
- **Improved error handling**: Better error responses following OpenAI API error format

## New in 0.0.2
- Modern esbuild build pipeline for faster, reliable TypeScript builds
- Extension and server configuration now fully align with VS Code settings (model, URL, port, etc.)
- Enhanced sidebar UI and logging, especially for model selection
- Improved sidebar panel and webview styling
- Initial VS Code settings configuration added
- Dependency and script updates for easier development

## New in 0.0.1
- Commands are no longer available in the Command Palette.
- Access all server controls and configuration via the VSLLM Server sidebar icon.


## Features
- Expose VS Code chat models as an OpenAI-compatible API
- Local HTTP server for chat completions
- Configure model, URL, port, API key, logging, and max tokens via VS Code settings or sidebar
- Start, stop, restart server, and open configuration panel from the VSLLM Server sidebar

### Sidebar Panel 
![VSLLM Server Sidebar Panel](docs/pic/panel.png)

## Prerequisites
**Important**: This extension requires Node.js to be available in your environment. If you're using conda, make sure to activate your conda environment that contains Node.js before starting VS Code:

```bash
conda activate your_env_name  # where your_env_name contains nodejs
code .  # then start VS Code from the activated environment
```

This ensures the extension can properly compile TypeScript and run without getting stuck in "activating" state.

## Installation
1. Download the `.vsix` package from the [Releases page](https://github.com/jianlins/vsllm_server/releases), or build it yourself (see [Building and releasing](#building-and-releasing)).
2. In VS Code, open the command palette (`Ctrl+Shift+P`) and run `Extensions: Install from VSIX...`.
3. Select the `.vsix` file to install.
4. After installation, look for the VSLLM Server icon in the sidebar to access all features.

## Configuration
All options are available in the VSLLM Server sidebar panel or in VS Code settings:

- **Model Selection**: ⚠️ The settings dropdown for model selection is a placeholder and will show "pending...". To select a model, open the VSLLM Server sidebar panel first. The sidebar will show the latest available models and allow you to select one dynamically.
- **Server URL**: Set the base URL (default: `http://localhost`).
- **Server Port**: Set the port number (default: `8801`).
- **API Key**: Optional authentication key.
- **Enable Logging**: Toggle verbose logging.

## Usage
- Use the VSLLM Server sidebar icon to start, stop, restart the server, and open the configuration panel.
- Configure all options in the sidebar or in the settings panel under "VSLLM Server Configuration".
- Access the API at `http://localhost:8801/v1/chat/completions` (or your configured URL/port).

## Using with OpenAI-Compatible Clients

This extension exposes VS Code's Copilot models as an OpenAI-compatible API. You can use any OpenAI client library or tool by pointing it to the VSLLM Server URL.

### Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8801/v1",
    api_key="not-needed"  # API key is optional
)

response = client.chat.completions.create(
    model="vsllm-copilot",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True  # Streaming supported
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### qwen-code / Continue / Other Extensions
Set your OpenAI base URL to point to VSLLM Server:
```
OPENAI_BASE_URL=http://localhost:8801/v1
```

### curl
```bash
# Non-streaming
curl http://localhost:8801/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello!"}]}'

# Streaming
curl http://localhost:8801/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello!"}], "stream": true}'

# List models
curl http://localhost:8801/v1/models
```

## Building and releasing

Build a `.vsix` locally:

```bash
npm ci
npm run vsix
```

Releases are automated by the [Build and Release VSIX](.github/workflows/release.yml) workflow:

- **Tagged push** — pushing a tag that matches `v*` (for example `v0.0.4`) builds the extension and creates a GitHub release with the `.vsix` attached. The tag must match the `version` in `package.json`, otherwise the workflow fails.
- **Manual run** — trigger the workflow from the Actions tab. By default it only builds and uploads the `.vsix` as a workflow artifact; enable the `release` input to also publish a GitHub release (optionally with a custom `tag` and a `prerelease` flag).

Typical release flow:

```bash
# bump "version" in package.json, then:
git commit -am "Release 0.0.4"
git tag v0.0.4
git push origin main --tags
```

## License
MIT

## Issues
Report issues at [GitHub Issues](https://github.com/jianlins/vsllm_server/issues).
