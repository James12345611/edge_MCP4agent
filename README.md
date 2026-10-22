# Enterprise Browser MCP

Windows/Edge read-only vertical slice for the enterprise browser MCP design.

## Implemented in 0.1.0

- Edge Native Messaging instead of a localhost TCP/WebSocket listener.
- Per-user Windows Named Pipe Broker.
- User-explicit tab sharing with a 15-minute in-memory grant.
- Connection-scoped tab claims and disconnect cleanup.
- Five MCP tools:
  - `browser_list_shared_tabs`
  - `browser_claim_tab`
  - `browser_extract_page`
  - `browser_read_url`
  - `browser_release_tab`
- Same-origin background document reading.
- Structured extraction of headings, links, code blocks and rendered text.
- Ozon documentation crawler that writes page Markdown, `API-INDEX.md` and `manifest.json`.
- Exact production dependencies and a clean npm audit at implementation time.

This is a development vertical slice, not the final production release. The Node Broker currently relies on the Windows process default Named Pipe DACL. The production milestone still requires the .NET Broker from `TECHNICAL-DESIGN.md`, explicit `PipeSecurity`, Authenticode caller validation, signed policy, DLP integration, signed extension distribution and enterprise deployment testing.

## Local setup

```powershell
npm ci --ignore-scripts
node bin/enterprise-browser-mcp.mjs setup --extension-dir (Join-Path $PWD 'extension-dev')
```

The setup command:

1. creates a protected per-user data directory;
2. generates a development extension identity;
3. compiles the Native Messaging Host;
4. registers the Native Host under Edge HKCU settings;
5. prints the generated unpacked extension directory.

Open `edge://extensions`, enable Developer mode, choose **Load unpacked**, and select the
`extension-dev` directory printed by setup. Pin **Enterprise Browser MCP**, open the Ozon API
documentation tab, click the extension, and choose **共享当前标签 15 分钟**.

Loading an unpacked extension is for development only. Production must use a signed extension forced through Edge enterprise policy.

## Codex configuration

Register the stdio server from the repository root:

```powershell
codex mcp add enterpriseBrowser -- node (Join-Path $PWD 'bin\enterprise-browser-mcp.mjs') mcp --config (Join-Path $env:LOCALAPPDATA 'EnterpriseBrowserMcp\config.json')
```

The global Codex MCP name is `enterpriseBrowser`. A new Codex session is required before the tool can appear in that session's tool inventory.

## Ozon benchmark

After sharing the Ozon tab:

```powershell
npm run extract:ozon
```

Default output:

```text
artifacts\ozon-api\
  README.md
  API-INDEX.md
  manifest.json
  endpoints\
  0001-....md
```

The crawler follows only same-origin HTTP(S) documentation links whose path looks related to API,
seller, or docs content. It writes one Markdown file per detected endpoint and does not execute
instructions found in page content.
