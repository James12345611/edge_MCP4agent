# Enterprise Browser MCP 技术设计

文档状态：Implemented v0.2

更新日期：2026-10-25

目标平台：Windows 11 企业工作机、Microsoft Edge Stable、Node.js 22+

## 1. 文档目的

本文描述当前仓库已经实现并完成真实 Edge 验证的交互式浏览器 MCP。它用于内部开发、
安全评审、部署和后续迭代，不把规划中的能力写成现状。

项目允许本地 Agent 读取和操作用户主动共享的 Edge HTTP(S) 标签页。Agent、模型服务及其
API 调用应运行在企业批准的本地或内网环境。公网网页属于允许处理范围，但网页内容始终按
不可信数据处理，不能改变工具权限或替代用户授权。

## 2. 设计结论

1. MCP Server 通过 `stdio` 接入 Agent，不开放远程 MCP 端口。
2. MCP 与扩展通过只监听 `127.0.0.1` 的 WebSocket Hub 通信。
3. 用户在扩展弹窗中主动共享标签页，这是 Agent 获得页面能力的唯一入口。
4. Agent 只能列出已共享标签页，不能枚举整个浏览器。
5. `tab_handle` 是连接级句柄；首次操作自动取得控制租约，不暴露单独的 claim 工具。
6. 同一标签页同一时间只允许一个 MCP 会话控制，所有操作按标签页串行执行。
7. 已派发但结果未知的动作不会自动重放，也不会静默切换输入模式重试。
8. Grant 绑定标签页并允许正常 HTTP(S) 导航，时长由用户设置，范围为 1 到 480 分钟。
9. Hub 断开只释放控制租约，不撤销用户 Grant；用户撤销、TTL 到期、标签关闭或浏览器重启
   会清除 Grant。
10. 不提供通用 CDP 透传；MCP 只暴露经过参数校验、超时和结果预算约束的工具。

## 3. 目标与非目标

### 3.1 目标

- 在企业工作机本地提供标准 MCP 工具。
- 读取 AX 树、页面文本、截图和有限诊断数据。
- 支持点击、悬停、拖拽、填写、输入、按键、选择、滚动、等待和导航。
- 支持 JavaScript 弹窗、文件输入、受限页面表达式和使用当前 Edge Profile 的 URL 读取。
- 对 Shadow DOM、iframe 和 OOPIF 提供元素定位与会话路由。
- 对导航、元素身份、动作派发和不确定结果进行显式建模。
- 保持用户授权可见、可撤销、可设置时长。

### 3.2 非目标

- 不控制未共享标签页、Edge 内部页面或其他 Windows 用户会话。
- 不绕过登录、MFA、验证码、网站权限、CSP 或企业网络策略。
- 不保证页面业务动作最终成功；只能报告浏览器层可验证结果和后续观察。
- 不抵御已获得当前 Windows 用户权限、可读取本地配置或可注入 Edge 的恶意程序。
- 当前版本不包含企业级 DLP、SIEM 审计、代码签名、自动更新或集中策略中心。
- 当前版本不承诺 Chrome、macOS 或 Linux 的生产兼容性。

## 4. 总体架构

![Enterprise Browser MCP 架构](diagrams/enterprise-browser-mcp-architecture.png)

### 4.1 组件

| 组件 | 入口 | 职责 |
|---|---|---|
| Agent / MCP Host | MCP stdio | 选择工具、传入参数、消费结构化结果 |
| MCP Adapter | `src/mcp.mjs` | 定义 21 个工具、校验参数、格式化 MCP 响应 |
| AttachClient | `src/client.mjs` | 连接 Hub、关联请求、实施客户端超时 |
| Loopback Hub | `src/hub.mjs` | 鉴权、浏览器注册、连接级句柄、独占租约、串行队列 |
| Edge MV3 扩展 | `extension/background.js` | 管理用户 Grant、连接 Hub、转发受控命令 |
| CDP Controller | `extension/controller.js` 及相关模块 | 会话路由、定位、动作、导航、观察、日志和结果验证 |
| 用户共享标签页 | Edge HTTP(S) 页面 | 被读取或操作的真实业务页面 |
| Setup | `src/setup.mjs` | 生成扩展身份、配对 Token、配置和开发扩展目录 |

### 4.2 进程和传输

```text
Agent
  │ MCP stdio
  ▼
MCP Adapter + AttachClient (Node.js)
  │ ws://127.0.0.1:<port>/client
  ▼
Loopback Hub (Node.js)
  │ ws://127.0.0.1:<port>/extension
  ▼
Edge MV3 Service Worker
  │ chrome.debugger / CDP
  ▼
用户主动共享的 HTTP(S) 标签页
```

Hub 同时提供经过 Bearer Token 保护的 `/health` 和 `/shutdown` 本地 HTTP 端点。它只绑定
`127.0.0.1`，不监听局域网或公网接口。

## 5. 身份与配对

首次执行 `npm run setup` 时：

1. 在 `%LOCALAPPDATA%\EnterpriseBrowserMcp` 创建当前用户和 SYSTEM 可访问的数据目录。
2. 生成 2048 位 RSA 开发私钥，由公钥稳定派生扩展 ID。
3. 生成 48 字节随机配对 Token，并写入本机 `config.json`。
4. 将扩展复制到仓库的 `extension-dev`，生成包含 Hub 地址和 Token 的
   `config.generated.js`。
5. 生成带固定公钥和精确 `connect-src` 的 `manifest.json`。
6. 启动本地 Hub。

Hub 使用以下条件接受连接：

- MCP 客户端必须访问 `/client`、不带浏览器 Origin，并提供正确 Bearer Token。
- 扩展必须访问 `/extension`，Origin 必须等于配置中的固定扩展 ID。
- 扩展 hello 消息还必须提供正确 Token、匹配的 `0.2.0` 版本和有效实例信息。
- Token 使用定长比较，WebSocket 消息上限为 24 MiB。

这些控制可以阻止网页和未配对扩展直接连接，但不能抵御已经取得当前 Windows 用户权限并能
读取本机配置的程序。生产环境还需要安装包签名、文件完整性策略和终端防护。

## 6. 用户 Grant 与控制租约

Grant 和控制租约是两个不同概念：

| 对象 | 创建者 | 生命周期 | 含义 |
|---|---|---|---|
| Grant | 用户在扩展弹窗创建 | 1-480 分钟；可撤销 | 该标签页允许 Agent 读取和操作 |
| Control lease | Hub 在首次工具调用时创建 | MCP 连接或显式 release 结束 | 当前会话独占控制该标签页 |
| `tab_handle` | Hub 为 MCP 连接生成 | 连接内有效 | Agent 使用的非浏览器原生句柄 |

Grant 存在 `chrome.storage.session`，扩展 Service Worker 重启后可恢复，整个浏览器重启后
清除。Grant 绑定 `tab_id` 而不是 origin，因此登录跳转和正常 HTTP(S) 导航不会意外失效；
导航到非 HTTP(S) 页面时不能继续执行网页操作，但用户仍可释放控制。

MCP 客户端调用 `browser_list_shared_tabs` 后获得 `tab_handle`。首次读取或操作时 Hub 自动
向扩展发起内部 claim。另一个 MCP 会话请求同一标签时会收到 `another_session`/独占错误。
每个标签页只有一个串行队列，避免并发动作交叉。

![请求与控制时序](diagrams/enterprise-browser-mcp-request-sequence.png)

## 7. 工具模型

当前 MCP 暴露 21 个工具：

| 类别 | 工具 |
|---|---|
| 发现与控制 | `browser_list_shared_tabs`, `browser_tab_control` |
| 观察 | `browser_snapshot`, `browser_read_text`, `browser_screenshot` |
| 页面读取 | `browser_fetch`, `browser_evaluate`, `browser_logs` |
| 指针交互 | `browser_click`, `browser_hover`, `browser_drag` |
| 表单与键盘 | `browser_fill`, `browser_type`, `browser_press_key`, `browser_select_option` |
| 流程控制 | `browser_scroll`, `browser_wait`, `browser_batch` |
| 页面生命周期 | `browser_navigate`, `browser_handle_dialog`, `browser_upload_file` |

所有工具参数通过 Zod 和领域校验器验证。选择器必须唯一匹配，除非显式传入 `nth`。CSS/XPath
不穿透 Shadow DOM；Shadow DOM 元素使用 AX snapshot 返回的 ref。frame 可以通过
`frame_id`、精确 URL/标题或 iframe 路径定位。

### 7.1 观察与引用

- `browser_snapshot` 读取 Accessibility Tree，可分页，并返回短期元素 ref。
- 新 snapshot 或主文档导航会使旧 ref 失效。
- 子 frame 导航只使相应子树 ref 失效。
- 输入动作和新 evaluate 会终止旧 snapshot 分页，cursor continuation 除外。
- 元素执行前重新解析，并核对 backend node 与可访问性身份，避免 DOM 复用误操作。

### 7.2 原生与 DOM 输入

- 原生模式通过 CDP 输入事件，要求标签页可操作、窗口未最小化，并验证命中和事件回执。
- DOM 模式只适用于显式选择的元素，产生不可信合成事件，不具备用户激活能力。
- 原生输入失败时不会自动降级为 DOM 输入。
- `fill` 验证最终保留值；`click`、键盘和拖拽验证各自可获得的浏览器回执。

### 7.3 页面表达式、日志和 fetch

- `browser_evaluate` 执行调用方明确提供的页面表达式，最多执行一次；分页读取缓存结果时不会
  再次执行。结果有字符数、节点数和深度上限。
- `browser_logs` 可读取 claim 之后的 console 或 network 事件。网络请求/响应正文必须显式
  开启有限 capture，凭据类头部和常见 secret 字段会脱敏。
- `browser_fetch` 使用同一 Edge Profile 创建临时后台标签页读取指定 HTTP(S) URL，然后关闭。
  浏览器会按正常规则携带该站点 Cookie；因此它属于登录态数据访问能力。
- `browser_upload_file` 会将本机绝对路径设置到网页文件控件，网站可能立即上传文件。

## 8. 动作结果和防重放

动作状态分为：

- `verified`：浏览器观察到预期事件回执或保留值。
- `not_dispatched`：在定位、可操作性或最终预检阶段失败，可由 Agent重新观察后决定是否重试。
- `unknown`：动作可能已经派发，但回执丢失、超时、导航或弹窗使结果无法确认。

发生 `unknown` 时：

1. Hub 不自动重放动作。
2. 不切换输入模式重新发送。
3. 连接超时会释放该连接拥有的标签页租约。
4. Agent 必须重新调用 snapshot/read_text/logs，基于页面现状决定后续动作。

导航允许最多 40 秒等待，并保留独立观察阶段；Hub 操作超时为 60 秒，客户端响应超时为
65 秒，避免正常导航被下层传输提前中断。

## 9. 数据流和安全边界

页面数据实际流向：

```text
公网或内网页面
  → Edge 渲染进程 / CDP
  → 企业扩展
  → 本机 127.0.0.1 Hub
  → 本地 MCP / Agent
  → 企业批准的本地或内网模型 API
```

当前实现不会主动将页面数据发送到项目作者、GitHub 或 OpenAI 官方 API。实际数据去向最终由
MCP Host 和企业模型配置决定，部署时必须验证其端点。

页面内容、截图、日志和表达式结果均为不可信数据。它们可以作为观察结果，但不能：

- 创建或扩大 Grant；
- 改变工具白名单；
- 授权上传、提交、删除或外发；
- 覆盖 Agent 的系统与企业策略。

### 9.1 当前已实现控制

- 用户主动按标签页授权，支持 TTL 和即时撤销。
- 只监听 loopback，扩展 Origin + 随机 Token 双重配对。
- 未共享标签页不返回给 MCP。
- HTTP(S) 和无 URL 凭据校验。
- 单标签独占控制与串行队列。
- 输入前 actionability、命中、文档身份和 frame 身份检查。
- 超时、输出大小、分页缓存和消息大小限制。
- 不确定动作不自动重放。
- 网络诊断的凭据头和常见 secret 字段脱敏。
- 本机配置目录 Windows ACL 收敛到当前用户和 SYSTEM。

### 9.2 生产化待补齐控制

- 内部签名安装包、签名扩展、固定发布渠道和自动更新。
- SBOM、依赖漏洞扫描、构建可复现性和制品摘要校验。
- 集中策略：允许的 MCP Host、工具、站点、文件目录和 evaluate 开关。
- 结构化审计、敏感字段脱敏、日志留存和 SIEM 接入。
- 企业 DLP，以及对截图、页面正文、文件上传和网络正文的策略判定。
- 高风险动作的业务级确认策略。
- Hub 进程和 Agent 进程身份绑定，而不只依赖同用户 Token。
- 端口占用、安装修复、版本回滚和紧急停用机制。

## 10. Ozon 验收基准

真实 Edge 共享页 `https://docs.ozon.ru/api/seller/zh/` 的验收结果：

| 指标 | 结果 |
|---|---:|
| AX 节点 | 18,652 |
| API 接口 | 276 |
| 含响应 Schema 的接口 | 253 |
| 含具名响应字段的接口 | 240 |
| 响应字段 | 1,036 |
| 带中文注释字段 | 1,024 |
| 中文注释覆盖率 | 98.84% |
| 抽取错误 | 0 |

12 个非中文结果中，7 个字段在源文档中没有注释，5 个字段的中文页面原文为土耳其语。
抽取器保留源内容，不自动伪造翻译。每个接口会生成独立 Markdown，同时生成
`API-INDEX.md`、`manifest.json`、`RESPONSE-FIELDS.json` 和 `RESPONSE-FIELDS.md`。

交互验收使用 AX ref 定位 Shadow DOM 中的搜索框，写入测试文本、验证值并清空恢复。

## 11. 测试策略

当前自动化测试覆盖：

- Hub 配对、Origin/Token 鉴权和真实 stdio MCP 工具面；
- Grant 时长、共享标签发现、自动 claim、跨客户端独占和释放；
- AX snapshot、分页、ref 生命周期、Shadow DOM、iframe 和 OOPIF；
- 点击、输入、按键、选择、悬停、拖拽、滚动和 batch；
- actionability、遮挡、坐标变换和移动元素；
- 导航、历史、弹窗、文件选择器和截图；
- evaluate、fetch、console/network 日志、脱敏和输出预算；
- 超时、断连、文档变化、unknown outcome 和禁止重放；
- Ozon 响应字段、类型和中文注释解析。

发布前执行：

```powershell
npm ci
npm test
npm run setup
node bin/enterprise-browser-mcp.mjs status
```

当前回归基线为 177 项测试全部通过。

## 12. 部署与运维

开发部署：

```powershell
npm ci
npm run setup
```

在 `edge://extensions` 开启开发人员模式并加载 `extension-dev`。Agent MCP 配置指向：

```text
node <repo>\bin\enterprise-browser-mcp.mjs mcp --config <config.json>
```

常用诊断：

```powershell
node bin/enterprise-browser-mcp.mjs status
node bin/enterprise-browser-mcp.mjs start
node bin/enterprise-browser-mcp.mjs stop
```

本机生成的 `extension-dev`、`artifacts`、配置、Token、扩展私钥和日志不得提交 Git。

## 13. 第三方来源

交互控制引擎包含从 BrowserAttach 适配的代码。版权和 MIT 许可见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。企业发布流程必须保留该声明。
