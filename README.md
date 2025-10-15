# VSCode LLM Server

Expose VSCode chat models as an OpenAI-compatible API endpoint. This extension provides a local HTTP server with a `/v1/chat/completions` endpoint, powered by VS Code's Language Model API.


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
1. Download or build the `.vsix` package.
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

## License
MIT

## Issues
Report issues at [GitHub Issues](https://github.com/jianlins/vsllm_server/issues).
