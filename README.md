# Enterprise Browser MCP 内部使用手册

Enterprise Browser MCP 用于让企业内部本地 Agent 读取和操作员工在 Microsoft Edge
中主动共享的网页。当前 `v0.2` 提供 AX 快照、点击、输入、滚动、导航、弹窗、
截图、文件上传、页面脚本和网络日志等交互能力。

> 当前仓库是内部开发验证版本。Agent、模型服务和 API 均应运行在企业批准的本地或
> 内网环境。页面操作可能改变真实业务状态，执行提交、删除、审批等动作前应先观察页面结果。

## 1. 当前能力

当前提供以下 MCP 工具：

| 工具 | 用途 |
|---|---|
| `browser_list_shared_tabs` | 查看用户主动共享且仍在有效期内的标签页 |
| `browser_snapshot` / `browser_read_text` | 读取 AX 树、交互元素引用和页面正文 |
| `browser_click` / `browser_hover` / `browser_drag` | 原生鼠标交互 |
| `browser_fill` / `browser_type` / `browser_press_key` | 表单填写和键盘输入 |
| `browser_scroll` / `browser_wait` | 有界滚动和条件等待 |
| `browser_navigate` / `browser_handle_dialog` | 导航、前进后退和 JavaScript 弹窗 |
| `browser_screenshot` | 获取视口、全页或元素截图 |
| `browser_upload_file` | 向明确的文件输入控件设置本机文件 |
| `browser_evaluate` / `browser_logs` | 执行受限页面表达式，读取 console/network 诊断信息 |
| `browser_fetch` / `browser_batch` | 使用当前 Edge Profile 读取 URL，或执行有界动作序列 |
| `browser_tab_control` | 激活、释放或关闭共享标签页 |

安全边界：

- 扩展不会枚举或上报未共享标签页。
- 只接受普通 HTTP(S) 页面，不控制 Edge 内部页面或带 URL 凭据的页面。
- 共享授权绑定标签页，在普通 HTTP(S) 导航和登录跳转后继续有效。
- 扩展只连接 `127.0.0.1` Hub，使用安装级随机 Token、固定扩展 Origin 和版本校验。
- 页面授权到期、用户撤销或标签关闭后，控制立即失效。
- 每个标签页串行执行；输入已经派发但结果未知时不会自动重放。

## 2. 环境要求

- Windows 11 企业工作机。
- Microsoft Edge Stable。
- Node.js 22 或更高版本。
- Git。

## 3. 首次安装

在 PowerShell 中执行：

```powershell
git clone https://github.com/James12345611/edge_MCP4agent.git
Set-Location edge_MCP4agent
npm ci --ignore-scripts
node bin/enterprise-browser-mcp.mjs setup --extension-dir (Join-Path $PWD 'extension-dev')
```

安装命令会：

1. 在 `%LOCALAPPDATA%\EnterpriseBrowserMcp` 创建仅当前用户和 SYSTEM 可访问的数据目录。
2. 生成本机开发扩展身份。
3. 生成仅监听 `127.0.0.1` 的 Hub 配对 Token 和端口配置。
4. 在仓库的 `extension-dev` 目录生成可加载的扩展。
5. 启动本地 WebSocket Hub。

`extension-dev` 和本机私钥不会提交到 Git。

## 4. 加载 Edge 扩展

1. 打开 `edge://extensions`。
2. 开启“开发人员模式”。
3. 点击“加载解压缩的扩展”。
4. 选择仓库中的 `extension-dev` 目录。
5. 将 **Enterprise Browser MCP** 固定到 Edge 工具栏。

更新仓库或重新执行 setup 后，需要在 `edge://extensions` 中点击扩展的“重新加载”按钮。

## 5. 配置 Codex MCP

在仓库根目录执行：

```powershell
codex mcp add enterpriseBrowser -- node (Join-Path $PWD 'bin\enterprise-browser-mcp.mjs') mcp --config (Join-Path $env:LOCALAPPDATA 'EnterpriseBrowserMcp\config.json')
```

配置完成后新建 Codex 会话。已经运行的会话不会动态加载新注册的 MCP 工具。

可使用以下命令确认配置：

```powershell
codex mcp list
node bin/enterprise-browser-mcp.mjs status
```

## 6. 日常使用

1. 在 Edge 中打开需要 Agent 读取的页面。
2. 点击工具栏中的 **Enterprise Browser MCP**。
3. 在“授权时长”中输入 `1` 到 `480` 分钟。默认值为 `15` 分钟，设置保存在本机扩展中。
4. 点击“共享并允许 Agent 操作”。
5. 回到 Agent 会话并发起网页读取、交互或文档抽取任务。
6. 使用结束后点击“立即撤销”，无需等待授权自动过期。

修改授权时长只影响之后创建的授权。已经共享的标签页需要先撤销，再按新时长重新共享。

## 7. Ozon API 文档抽取示例

共享 Ozon Seller API 文档标签页后，在仓库根目录执行：

```powershell
npm run extract:ozon
```

默认输出目录为 `artifacts\ozon-api`：

```text
artifacts\ozon-api\
  README.md
  API-INDEX.md
  RESPONSE-FIELDS.json
  manifest.json
  endpoints\
  0001-....md
```

抽取器为每个识别出的接口生成独立 Markdown，并将响应字段路径、类型和中文注释写入
`RESPONSE-FIELDS.json`。网页正文被视为数据，不会作为新的 Agent 指令执行。
`artifacts` 默认不提交到 Git。

对已有导出重新分析响应字段：

```powershell
npm run analyze:ozon-responses
```

## 8. 常见问题

### 扩展显示“本机服务未连接”

1. 执行 `node bin/enterprise-browser-mcp.mjs start`。
2. 在 `edge://extensions` 中重新加载扩展。
3. 必要时完全重启 Edge。
4. 确认扩展目录仍是当前仓库的 `extension-dev`。
5. 执行 `node bin/enterprise-browser-mcp.mjs status` 查看连接状态。

### Agent 看不到浏览器工具

- 确认 `codex mcp list` 中存在 `enterpriseBrowser`。
- 新建 Codex 会话。
- 确认当前 Agent 使用的是同一 Windows 用户。

### 共享后仍找不到标签页

- 确认授权尚未到期。
- 再次打开扩展，撤销后重新共享。

## 9. 操作约束

所有写操作遵循：

- 标签页由用户主动共享。
- 元素引用在执行前重新解析并核对 AX 身份。
- 原生输入要求目标标签页处于可操作状态；必要时先调用 `browser_tab_control` 激活。
- 操作串行执行，动作派发后不自动重试。
- `OUTCOME_UNKNOWN` 必须先重新 snapshot 或 read_text，再决定后续动作。

完整架构、数据流、安全边界、动作结果模型和生产化待办见
[`TECHNICAL-DESIGN.md`](TECHNICAL-DESIGN.md)。
