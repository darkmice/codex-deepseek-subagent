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
2. On macOS, use the Codex binary bundled with the current desktop app (or a
   matching current CLI release), ensure Codex Multi-Agent v2 is enabled (see below), save
   the API key, refresh the model list, and save the default model. The list
   combines DeepSeek `/v1/models` with the multimodal `deepseek-flash` model.
   Saving a model verifies it with a minimal Responses request, starts a user
   LaunchAgent, and installs a marked loopback provider route.
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

保存 key 和默认模型前，按上面的形式启用 Multi-Agent v2；其中
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
managed role selects the saved model; requests whose model matches that saved
model have their authorization replaced and are sent to DeepSeek. Custom
providers with unsupported routing/header fields fail closed.

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

插件不会修改主任务模型。由于当前 Codex 的 child role override 不传递
`model_provider`，插件会把有效 provider 改为本机路由；父任务携带原授权继续转发到
当前 provider 解析出的原上游。skill 以 `agent_type: "deepseek"` 调用原生
`spawn_agent` 后，受管角色选择 DeepSeek 模型；请求模型与该模型一致时，路由替换
授权并发送到 DeepSeek。无法安全保留路由/header 的自定义 provider 会 fail closed。

Codex 会按 ChatGPT provider 加密原生协作消息正文。spawn 前，skill 会先调用
`deepseek_delegation_prepare`，把明确且有界的委派正文交给本地 router；router 只在
短期内存中保存正文并返回随机任务名。skill 随即以同一任务名和正文调用原生
`spawn_agent`。router 按任务名匹配 child 请求，移除 DeepSeek 无法解密的 provider
专属密文并注入正文；状态缺失、过期或不匹配时 fail closed。MCP 工具不调用模型，
委派正文不会写入 router 状态或日志。
工具续请求只使用成功 DeepSeek JSON 或 SSE 响应中观察到的、按 task 绑定的 reasoning
密文 HMAC 摘要；未知、跨 task、畸形或位置错误的加密内容会在出网前被拒绝，router
不会保存密文原文。

The router augments the authenticated parent `/models` response with only the
selected plugin-generated DeepSeek model entry. This preserves the official
ChatGPT model catalog and gives the child explicit modality metadata; the
DeepSeek entry is hidden from the parent model picker so it cannot become the
primary task's default model.

路由只向已认证父 provider 的 `/models` 响应追加当前所选的插件生成 DeepSeek 条目，
不会替换 ChatGPT 官方模型目录。该条目向 child 提供明确的模态 metadata，并从父任务
模型选择器隐藏，避免 DeepSeek 意外成为主任务默认模型。

## Local data / 本地数据

The API key remains in the platform-specific settings file with private Unix
permissions where supported:

- macOS: `~/Library/Application Support/DeepSeek Subagent/settings.json`
- Windows: `%APPDATA%\DeepSeek Subagent\settings.json`
- Linux: `$XDG_CONFIG_HOME/deepseek-subagent/settings.json`, or
  `~/.config/deepseek-subagent/settings.json`

If Settings reports that this file is damaged, close Codex, make a private
backup only if needed, and remove only this `settings.json`. Reopen Settings to
recreate it. If uninstalling, run the standalone cleanup command again after
removing the damaged file. Never share the backup because it may contain the
API key.

The generated catalog and router state live beside that file. The
plugin-managed role is `~/.codex/agents/deepseek-subagent.toml` (or the active
`CODEX_HOME`). Router state is stored beside the settings file, and its macOS
LaunchAgent is user-scoped. Deleting the key immediately disables DeepSeek,
restores the previous provider assignment for new tasks, and retains parent
pass-through for already-open routed tasks for up to ten minutes before cleanup.
Only plugin-managed files are removed; an unmanaged role at the same path is
never overwritten or deleted. The same fail-closed ownership check applies to
the fixed LaunchAgent path and registered service label.

完整 API key 不会进入仓库、分发包、命令参数、日志或工具返回；它会作为认证信息发送
给所配置的 DeepSeek API。删除 key 会立即禁用 DeepSeek、为新任务恢复此前 provider，
并为已打开任务保留最长十分钟的父请求透传；只删除带插件所有权标记的受管原生文件，
不会覆盖或删除同路径的用户文件。

如果设置页提示上述 `settings.json` 已损坏，请关闭 Codex；如确有需要先做私密备份，
然后只删除该文件。重新打开设置页会重建它；若正在卸载，请随后再次运行独立清理命令。
备份可能包含 API key，不得分享。

The router binds only to `127.0.0.1` behind a random capability path. It never
logs request bodies or authorization headers. ChatGPT authorization is never
forwarded to DeepSeek. Native routing is currently unavailable on Windows and
Linux; connection and model discovery remain available there.

A delegated DeepSeek provider payload can include the explicit task message,
model context assembled for the child, tool definitions and results, and any
attachments included in that child request. The plugin does not send the full
parent history when `fork_turns: "none"` is used.

The preparation call is still normal Codex tool history, so Codex may retain
its arguments. The router's in-memory-only guarantee does not make delegation
messages secret from Codex or DeepSeek.

路由只监听 `127.0.0.1`，并使用随机 capability 路径；不记录请求正文或认证头，也绝不
把 ChatGPT 授权转发给 DeepSeek。Windows 与 Linux 目前只能使用连接与模型发现，尚不
支持此原生路由。

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
the bounded task message is passed explicitly. Cross-provider follow-ups are
not supported because the current encrypted envelope has no safe per-message
binding; prepare and spawn a fresh bounded child for additional work. If the
child's terminal event arrives before the parent calls `wait_agent`, the parent
uses that result directly. A wait timeout is only a lack of a new mailbox event;
the parent checks the matching task-tree state before classifying the child as
failed.

新任务中可以直接说“使用原生 DeepSeek 子智能体检查这个项目”。父任务直接调用
`deepseek_delegation_prepare`；该调用会先检查就绪状态，不会加载设置页。只有
用户主动查看或修改设置，或预备阶段报告配置未完成时，才使用设置工具。随后以
Codex 原生协作工具执行委派；跨 provider 不复制历史。当前加密 envelope 没有可安全绑定
的逐消息标识，因此不支持跨 provider follow-up；追加工作需重新预备并创建新的 child。
若 child 的终态事件先于 `wait_agent` 到达，父任务直接使用该结果，不再重复等待；等待
超时只表示没有新的 mailbox 事件，必须回读对应任务树状态后才能判定失败。

## Uninstall / 卸载

Before uninstalling, use **Delete key** in Settings or run the independent
cleanup copy installed beside `settings.json`:

```sh
node "$HOME/Library/Application Support/DeepSeek Subagent/cleanup.mjs"
```

The command remains available after plugin source removal. It immediately
stops the owned LaunchAgent, restores the previous provider, and removes the
credential plus all verified plugin-managed native files. Start a new Codex
task before uninstalling. Conflicting files with unverifiable ownership are
left untouched and cause cleanup to fail closed.

卸载前请在设置页点击**删除 Key**，或执行上面的独立清理命令。该脚本与
`settings.json` 同目录安装，即使插件源码已删除仍可运行；它会立即停止插件所有的
LaunchAgent、恢复原 provider，并删除凭据及所有可验证的受管原生文件。随后新建 Codex
任务再卸载。无法验证所有权的冲突文件会保留，清理会 fail closed。
