# Enterprise Browser MCP 内部使用手册

Enterprise Browser MCP 用于让企业内部 Agent 读取员工在 Microsoft Edge 中明确授权的网页。
当前 `v0.1` 为只读版本，适合网页信息提取、文档归档和知识整理，不具备点击、输入、
提交表单等写操作能力。

> 当前仓库是开发验证版本，不是已完成安全评审的生产制品。请勿在包含企业敏感数据、
> 个人隐私或生产管理权限的页面上试用。正式部署仍需完成代码签名、Named Pipe ACL、
> 调用方身份校验、DLP、审计和 Edge 企业策略配置。

## 1. 当前能力

当前提供以下 MCP 工具：

| 工具 | 用途 |
|---|---|
| `browser_list_shared_tabs` | 查看用户主动共享且仍在有效期内的标签页 |
| `browser_claim_tab` | 为当前 MCP 会话声明一个共享标签页 |
| `browser_extract_page` | 提取当前页面的标题、正文、标题层级、链接和代码块 |
| `browser_read_url` | 在共享页面同源范围内读取另一个文档 URL |
| `browser_release_tab` | 释放当前 MCP 会话对标签页的声明 |

安全边界：

- 扩展不会枚举或上报未共享标签页。
- 只接受普通 HTTP(S) 页面，不接受 Edge 内部页面、带 URL 凭据的页面或跨域读取。
- 不开放任意 JavaScript、Cookie、浏览器存储、网络请求正文或文件上传能力。
- 扩展通过 Edge Native Messaging 连接本机程序，不监听 localhost TCP/WebSocket 端口。
- 页面授权到期、用户撤销、标签关闭或跳转到其他 origin 后，授权失效。

## 2. 环境要求

- Windows 11 企业工作机。
- Microsoft Edge Stable。
- Node.js 22 或更高版本。
- Git。
- Windows 自带的 .NET Framework C# 编译器：
  `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` 或 32 位对应路径。
- 有权限在当前用户的 `HKCU` 下注册 Edge Native Messaging Host。

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
3. 编译 Native Messaging Host。
4. 在当前用户的 Edge 注册表中注册 Native Messaging Host。
5. 在仓库的 `extension-dev` 目录生成可加载的扩展。

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
4. 点击“共享当前标签”。
5. 回到 Agent 会话并发起网页读取或文档抽取任务。
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
  manifest.json
  endpoints\
  0001-....md
```

抽取器只跟随共享 origin 内与 API 文档相关的 HTTP(S) 链接，并为每个识别出的接口生成
独立 Markdown。网页正文被视为不可信数据，不会作为指令执行。`artifacts` 默认不提交到 Git。

## 8. 常见问题

### 扩展显示“本机服务未连接”

1. 重新执行 setup。
2. 完全重启 Edge。
3. 在 `edge://extensions` 中重新加载扩展。
4. 确认扩展目录仍是当前仓库的 `extension-dev`。
5. 执行 `node bin/enterprise-browser-mcp.mjs status` 查看连接状态。

### Agent 看不到浏览器工具

- 确认 `codex mcp list` 中存在 `enterpriseBrowser`。
- 新建 Codex 会话。
- 确认当前 Agent 使用的是同一 Windows 用户。

### 共享后仍找不到标签页

- 确认授权尚未到期。
- 确认页面没有跳转到另一个域名。
- 再次打开扩展，撤销后重新共享。

### setup 提示 C# 编译器不可用

确认工作机包含 .NET Framework 开发组件或由内部安装包预编译并分发 Native Host。

## 9. 后续版本

当前版本刻意保持只读。后续将按照 `TECHNICAL-DESIGN.md` 的阶段 C 增加 Agent 操作网页的能力，
包括受控的点击、输入、滚动、按键、等待和同源导航。

交互版本仍不会提供任意 JavaScript 或通用 CDP 透传。所有写操作必须满足：

- 标签页由用户主动共享。
- 工具和目标站点在企业策略白名单内。
- 高风险动作可要求用户二次确认。
- 操作串行执行，具备防重放和不确定结果处理。
- 审计只记录经过脱敏的必要元数据。

生产发布前的完整安全要求、威胁模型和开发阶段见
[`TECHNICAL-DESIGN.md`](TECHNICAL-DESIGN.md)。
