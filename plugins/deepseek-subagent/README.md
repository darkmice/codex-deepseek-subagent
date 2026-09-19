# DeepSeek Subagent / DeepSeek 子智能体

DeepSeek Subagent connects DeepSeek to Codex's native `spawn_agent` runtime.
The child is a real Codex task with normal task-tree visibility, live status,
native waiting, and streamed output. The MCP server owns the settings UI and a
loopback preparation control plane, but it does not call a model, execute
delegated work, or launch a hidden `codex exec`.

DeepSeek Subagent 将 DeepSeek 接入 Codex 原生 `spawn_agent` runtime。child 是
真正的 Codex 子任务，具有原生任务树、实时状态、原生等待和流式输出。MCP server
负责设置页和本地委派预备控制面，但不调用模型、不执行委派任务，也不启动隐藏的
`codex exec`。

## Setup / 设置

1. Open **Settings → Integrations → DeepSeek Subagent**.
2. On macOS, Windows, or Linux, use the Codex binary bundled with the current
   desktop app (or a matching current CLI release), ensure Codex Multi-Agent v2 is enabled (see below), add
   one or more Base URL + API key connections, refresh the model list, and save the default model. Each
   connection has its own Base URL; new connections default to
   `https://api.deepseek.com/v1/` and may instead point to an HTTPS Responses-compatible proxy. The list
   is the intersection available from every currently usable enabled connection and includes the multimodal
   `deepseek-flash` model when its Responses probe succeeds.
   Saving a model verifies it with a minimal Responses request, starts a
   user-scoped router, and installs a marked loopback provider route. macOS
   uses LaunchAgent; Windows and Linux use an authenticated detached process
   without administrator privileges.
3. Start a new Codex task so the generated native agent role is loaded.

Before saving a model, add this table to `~/.codex/config.toml`:

```toml
[features.multi_agent_v2]
enabled = true
hide_spawn_agent_metadata = false
```

`enabled = true` is required. `hide_spawn_agent_metadata = false` is optional
and only keeps spawn metadata visible; custom `agent_type` values come from the
installed agent role. Remove the obsolete root-level
`multi_agent_v2.hide_spawn_agent_metadata` setting if present because current
Codex releases reject it in strict config mode. The plugin checks the v2
prerequisite. Saving a model then changes only a marked provider-routing block
and preserves the previous provider assignment for restoration.

添加一组或多组 Base URL + API Key 连接并保存默认模型前，按上面的形式启用 Multi-Agent v2。
每组连接都有自己的 Base URL；新连接默认使用 `https://api.deepseek.com/v1/`，也可填写
兼容 Responses API 的 HTTPS 代理地址。模型列表取当前可用且已启用连接的交集；其中
`hide_spawn_agent_metadata = false` 仅用于显示 spawn 元数据，并不是暴露
`agent_type` 的前置条件。若存在旧的根级配置
`multi_agent_v2.hide_spawn_agent_metadata`，请删除它。保存后新建一个 Codex 任务。
设置页会生成插件专属模型目录，将 DeepSeek 注册为原生 `deepseek` agent role，并写入
带标记、可恢复的 provider 路由配置。

The plugin never changes the primary task's model. It changes the effective
provider to a local router because current Codex child-role overrides do not
carry `model_provider`. Parent requests are forwarded to the upstream resolved
from the active ChatGPT-authenticated provider with their original
authorization. When native `spawn_agent` uses `agent_type: "deepseek"`, the
managed role selects the saved DeepSeek model. The installer also bridges the
original provider ID to the loopback router, so a reopened task that retains
that provider ID cannot send `deepseek-*` directly to ChatGPT. The router
recognizes only the exact prepared task envelope, replaces authorization, and
sends it to DeepSeek. Custom
providers with unsupported routing/header fields fail closed.

## Team orchestration / 团队编排

The plugin includes two complementary skills. `deepseek-subagent` owns one
bounded native delegation and its routing safety contract. `deepseek-team` is
an optional orchestration workflow: GPT plans the work and keeps architecture,
security judgment, visual decisions, integration, and final QA, while DeepSeek
children execute suitable bounded implementation, testing, debugging,
documentation, research, or data-processing tasks. Invoke it with
`$deepseek-team` or ask for GPT-led DeepSeek team execution.

插件包含两个互补的 Skill。`deepseek-subagent` 负责一次有界的原生委派及其路由安全
契约；`deepseek-team` 是可选编排工作流：GPT 负责规划，并保留架构、安全判断、视觉
决策、集成和最终 QA，DeepSeek 子智能体负责适合拆分的实现、测试、调试、文档、研究或
数据处理。可使用 `$deepseek-team`，或明确要求“由 GPT 主持、DeepSeek 执行”。

Team mode does not delegate secrets, credential handling, production writes,
destructive actions, release approval, or final security decisions. GPT treats
child output as untrusted until it has inspected the actual artifacts and
rerun appropriate verification. It does not promise a fixed benchmark score or
cost ratio.

团队模式不会委派密钥处理、生产写入、破坏性操作、发布审批或最终安全判断。GPT 必须
检查实际产物并重新验证，不能把子智能体报告直接当作完成证据，也不会承诺固定的性能或
成本比例。

Codex encrypts native collaboration message bodies for its ChatGPT provider.
Before spawning, the skill therefore calls `deepseek_delegation_prepare` with
the exact bounded message. The local router keeps it only in short-lived memory
and returns a randomized task name. The skill immediately calls native
`spawn_agent` with that name and the same message. The router injects the
prepared message into the matching DeepSeek child request, removes the opaque
provider-specific encrypted content, and fails closed when the state is
missing, expired, or mismatched. The MCP tool never calls a model; delegation
messages are never written to router state or logs.
For tool continuations, the router keeps only task-scoped HMAC digests of
reasoning ciphertext observed in a successful DeepSeek JSON or SSE response.
It accepts that exact ciphertext only for the same task and rejects unknown,
cross-task, malformed, or misplaced encrypted content before upstream access.
Unstarted preparations and pending follow-ups expire after at most ten minutes.
For same-child continuity, bounded plaintext turn history for an active task
remains only in router memory until 35 minutes idle or two hours absolute,
whichever comes first, and is never written to settings, runtime state, or logs.

插件不会修改主任务模型。由于当前 Codex 的 child role override 不传递
`model_provider`，插件会把有效 provider 改为本机路由；父任务携带原授权继续转发到
当前 provider 解析出的原上游。skill 以 `agent_type: "deepseek"` 调用原生
`spawn_agent` 后，受管角色选择已保存的 DeepSeek 模型。安装器也会把原 provider ID
桥接到 loopback router，因此重新打开后仍保留旧 provider ID 的任务不会把 `deepseek-*`
直接发给 ChatGPT。router 只识别精确预备的任务 envelope，随后替换授权并发送到 DeepSeek。无法安全保留
路由/header 的自定义 provider 会 fail closed。

Codex 会按 ChatGPT provider 加密原生协作消息正文。spawn 前，skill 会先调用
`deepseek_delegation_prepare`，把明确且有界的委派正文交给本地 router；router 只在
短期内存中保存正文并返回随机任务名。skill 随即以同一任务名和正文调用原生
`spawn_agent`。router 按任务名匹配 child 请求，移除 DeepSeek 无法解密的 provider
专属密文并注入正文；状态缺失、过期或不匹配时 fail closed。MCP 工具不调用模型，
委派正文不会写入 router 状态或日志。
工具续请求只使用成功 DeepSeek JSON 或 SSE 响应中观察到的、按 task 绑定的 reasoning
密文 HMAC 摘要；未知、跨 task、畸形或位置错误的加密内容会在出网前被拒绝，router
不会保存密文原文。
未启动的预备和待处理 follow-up 最长十分钟后过期。为复用同一 child，active task 的有界
明文轮次历史只保留在 router 内存中，在空闲 35 分钟或首次预备后两小时（以先到者为准）
清除，绝不写入设置、运行状态或日志。

The router augments the authenticated parent `/models` response with only the
selected plugin-generated DeepSeek model entry. This preserves the official
ChatGPT model catalog and gives the child explicit modality metadata; the
DeepSeek entry is hidden from the parent model picker so it cannot become the
primary task's default model.

路由只向已认证父 provider 的 `/models` 响应追加当前所选的插件生成 DeepSeek 条目，
不会替换 ChatGPT 官方模型目录。该条目向 child 提供明确的模态 metadata，并从父任务
模型选择器隐藏，避免 DeepSeek 意外成为主任务默认模型。

## Local data / 本地数据

The settings page manages an ordered pool of up to eight connections. Every item
contains its own local label, Base URL, API key, and enabled state; it can be
disabled, reordered, or removed independently. The same key may be used with
different endpoints, but an identical Base URL + key pair cannot be duplicated.
Only `401` (invalid connection) and `402` (insufficient balance) fail over before
any response bytes are sent. Failover switches the Base URL and API key together.
`429`, `5xx`, TLS/network failures, and timeouts stay on the current connection,
and a task that has already succeeded is pinned to its original connection for
every continuation. This is availability failover, not a way to multiply
one DeepSeek account's rate limit. Streaming responses are never replayed after
output begins. Exact concurrent or already committed follow-up replays are rejected
before another upstream execution. Provider request buffering is derived from the
router's V8 heap rather than the model context window: the default single-request
budget is at least 160 MiB and scales up to 1 GiB, with a separate heap-derived
global in-flight budget. Compressed inputs are bounded after decompression, and
`/healthz` reports the active byte budgets.
If all eligible connections are unavailable, or DeepSeek returns HTTP `413` before output begins, the task
is permanently rebound to the authenticated parent GPT provider and parent model.
Existing schema v1/v2 single-key settings and schema v3 pools with
a shared Base URL migrate automatically to schema v4 on the next settings write.
Changing a Base URL replaces that connection's identity, so an already-running
task can never drift to the edited endpoint.

设置页管理最多 8 个有序连接；每一项都有独立的本机标签、Base URL、API Key 和启用状态，
并可独立启停、排序或删除。同一个 Key 可以用于不同地址，但完全相同的 Base URL + Key
组合不能重复。仅 `401`（连接无效）和 `402`（余额不足）会在尚未输出响应字节时切换
下一组连接，切换时地址和 Key 会一起改变；`429`、`5xx`、TLS/网络失败及超时都停留在
当前连接。任务首次成功后，其所有续轮固定使用原连接；流式输出开始后不会重放。这是
可用性故障转移，不会提高同一 DeepSeek 账户的限流额度。完全相同的并发或已提交 follow-up
会在再次请求上游前被拒绝。provider 的缓冲预算根据 router 的 V8 heap 动态计算，而不是模型
上下文窗口：默认单请求预算至少 160 MiB、最高 1 GiB，另有独立的全局在途预算；压缩输入按
解压后大小受限，`/healthz` 会报告当前字节预算。当全部候选连接均不可用，或 DeepSeek 在尚未输出时返回 HTTP `413`，该任务会永久绑定回已认证的
父级 GPT provider 及其原模型。旧 schema v1/v2 单 Key 设置与
schema v3 共享 Base URL 连接池会在下一次设置写入时自动迁移为 schema v4。
修改 Base URL 会替换该连接的身份，因此已运行任务不会漂移到修改后的地址。

API keys remain in the platform-specific settings file with private Unix
permissions where supported:

- macOS: `~/Library/Application Support/DeepSeek Subagent/settings.json`
- Windows: `%APPDATA%\DeepSeek Subagent\settings.json`
- Linux: `$XDG_CONFIG_HOME/deepseek-subagent/settings.json`, or
  `~/.config/deepseek-subagent/settings.json`

Each Base URL is stored with its API key in the same file. It must be an absolute
HTTPS URL without embedded credentials, query, or fragment; plain HTTP is
accepted only for loopback testing. Adding a connection or changing any Base URL
clears the selected model and removes the old native route, so refresh and save a
model again before starting a new task.

每个 Base URL 都与对应 API Key 一起保存在同一设置文件中。地址必须是不含内嵌凭据、
查询参数或片段的绝对 HTTPS URL；只有本机回环测试允许 HTTP。新增连接或修改任何
Base URL 都会清空已选模型并移除旧原生路由，之后必须重新刷新并保存模型，再新建任务。

If Settings reports that this file is damaged, close Codex, make a private
backup only if needed, and remove only this `settings.json`. Reopen Settings to
recreate it. If uninstalling, run the standalone cleanup command again after
removing the damaged file. Never share the backup because it may contain the
API key.

The generated catalog and router state live beside that file. The
plugin-managed role is `~/.codex/agents/deepseek-subagent.toml` (or the active
`CODEX_HOME`). Router state is stored beside the settings file. Its macOS
LaunchAgent and its Windows/Linux detached process are user-scoped. Deleting all keys immediately disables DeepSeek,
restores the previous provider assignment for new tasks, and retains parent
pass-through for already-open routed tasks for up to ten minutes before cleanup.
Only plugin-managed files are removed; an unmanaged role at the same path is
never overwritten or deleted. On macOS, the same fail-closed ownership check
applies to the fixed LaunchAgent path and registered service label. On Windows
and Linux, replacement and shutdown require the matching random local runtime identity.

完整 API key 不会进入仓库、分发包、命令参数、日志或工具返回；它会作为认证信息发送
给所配置的 DeepSeek API。DeepSeek 响应头会被规范化、错误正文会被替换，成功响应流也会
在返回 Codex 前检查当前 Key，兼容代理无法把认证值反射进任务输出或日志。删除全部 key 会立即禁用 DeepSeek、为新任务恢复此前 provider，
并为已打开任务保留最长十分钟的父请求透传；只删除带插件所有权标记的受管原生文件，
不会覆盖或删除同路径的用户文件。

如果设置页提示上述 `settings.json` 已损坏，请关闭 Codex；如确有需要先做私密备份，
然后只删除该文件。重新打开设置页会重建它；若正在卸载，请随后再次运行独立清理命令。
备份可能包含 API key，不得分享。

The router binds only to `127.0.0.1` behind a random capability path. It never
logs request bodies or authorization headers. ChatGPT authorization is never
forwarded to DeepSeek. DeepSeek response headers are normalized, error bodies
are replaced, and successful response streams are checked for the active Key
before returning to Codex. Native routing is supported on macOS, Windows, and Linux.
The Windows/Linux detached router is recovered automatically on the next
delegation if its process exits unexpectedly.

A delegated DeepSeek provider payload can include the explicit task message,
model context assembled for the child, tool definitions and results, and any
attachments included in that child request. The plugin does not send the full
parent history when `fork_turns: "none"` is used.

The preparation call is still normal Codex tool history, so Codex may retain
its arguments. The router's in-memory-only guarantee does not make delegation
messages secret from Codex or DeepSeek.

路由只监听 `127.0.0.1`，并使用随机 capability 路径；不记录请求正文或认证头，也绝不
把 ChatGPT 授权转发给 DeepSeek。原生路由支持 macOS、Windows 与 Linux；若
Windows/Linux 后台 router 意外退出，下一次委派会自动恢复它。

发往 DeepSeek 的委派 payload 可能包含明确任务消息、为 child 组装的模型上下文、工具
定义与结果，以及该 child 请求携带的附件；使用 `fork_turns: "none"` 时不会复制完整
父任务历史。预备调用仍属于正常 Codex 工具历史，Codex 可能保留其参数；router 仅存
内存的保证不代表正文对 Codex 或 DeepSeek 保密。

## Delegation / 委派

In a new Codex task, ask: “Use a native DeepSeek subagent to inspect this
project.” The parent calls `deepseek_delegation_prepare` directly; that call
checks readiness before staging the exact message, without loading the settings
UI. The settings tool is used only when the user asks to view or change settings,
or when preparation reports incomplete setup. Delegation then continues with
Codex's native collaboration tools. Cross-provider history is not forked;
the bounded task message is passed explicitly. Related work can reuse an idle
or terminal child: the parent calls `deepseek_followup_prepare` and then
immediately calls native `followup_task` with the same task path and bounded
message. The router binds that plaintext turn to the ordered encrypted history
already committed for the same child. If the binding expired, preparation
fails closed and the parent prepares one
replacement child rather than retrying indefinitely. If the
child's terminal event arrives before the parent calls `wait_agent`, the parent
uses that result directly. A wait timeout is only a lack of a new mailbox event;
the parent checks the matching task-tree state before classifying the child as
failed. Within a running child, tool continuations and requests emitted after
context compaction remain bound through committed reasoning-ciphertext digests
and a completed DeepSeek `previous_response_id`. The generated model metadata
declares a 1,000,000-token window and reserves 5% for context management.

新任务中可以直接说“使用原生 DeepSeek 子智能体检查这个项目”。父任务直接调用
`deepseek_delegation_prepare`；该调用会先检查就绪状态，不会加载设置页。只有
用户主动查看或修改设置，或预备阶段报告配置未完成时，才使用设置工具。随后以
Codex 原生协作工具执行委派；跨 provider 不复制父任务历史。同一会话中的相关工作可复用
idle 或 terminal 的 child：父任务先调用 `deepseek_followup_prepare`，再立即使用同一 task
path 和有界正文调用原生 `followup_task`；router 将新正文绑定到同一 child 已提交的有序加密
历史。若绑定过期则在预备阶段失败关闭，并只创建一个替代 child，不无限重试。
若 child 的终态事件先于 `wait_agent` 到达，父任务直接使用该结果，不再重复等待；等待
超时只表示没有新的 mailbox 事件，必须回读对应任务树状态后才能判定失败。
运行中的 child 在工具续传或上下文压缩后，使用已提交的推理密文摘要和 DeepSeek
`previous_response_id` 继续绑定；模型目录声明 1,000,000 tokens，并为上下文管理保留 5%。

## Uninstall / 卸载

Before uninstalling, use **Delete key** in Settings or run the independent
cleanup copy installed beside `settings.json`:

macOS:

```sh
node "$HOME/Library/Application Support/DeepSeek Subagent/cleanup.mjs"
```

Linux:

```sh
node "${XDG_CONFIG_HOME:-$HOME/.config}/deepseek-subagent/cleanup.mjs"
```

Windows PowerShell:

```powershell
node "$env:APPDATA\DeepSeek Subagent\cleanup.mjs"
```

The command remains available after plugin source removal. It immediately
stops the owned router service/process, restores the previous provider, and removes the
credential plus all verified plugin-managed native files. Start a new Codex
task before uninstalling. Conflicting files with unverifiable ownership are
left untouched and cause cleanup to fail closed.

卸载前请在设置页点击**删除全部 Key**，或执行上面的独立清理命令。该脚本与
`settings.json` 同目录安装，即使插件源码已删除仍可运行；请按当前系统使用上方对应
命令。它会立即停止插件所有的 router 服务或进程、恢复原 provider，并删除凭据及所有
可验证的受管原生文件。随后新建 Codex 任务再卸载。无法验证所有权的冲突文件会保留，
清理会 fail closed。
