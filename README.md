# Codex DeepSeek Subagent team marketplace

This repository is a portable Codex team marketplace. 中文说明见各段下方。

## Install with Codex / 让 Codex 安装

Paste the following request into Codex. Codex should preserve existing user
configuration and must never ask you to paste the DeepSeek API key into chat or
a shell command. / 将下面这段话直接发给 Codex。Codex 应保留已有用户配置，且不得要求
你把 DeepSeek API Key 粘贴到聊天或 shell 命令中。

```text
请从公开仓库 darkmice/codex-deepseek-subagent 安装 DeepSeek Subagent 插件：

1. 使用当前 ChatGPT 桌面版自带的 Codex CLI，或兼容当前插件协议的新版 Codex CLI。
2. 先运行 `codex plugin marketplace list`。如果尚未添加该仓库，运行
   `codex plugin marketplace add darkmice/codex-deepseek-subagent --ref main`；
   如果 `deepseek-team` 已存在，则运行
   `codex plugin marketplace upgrade deepseek-team`。
3. 运行 `codex plugin add deepseek-subagent@deepseek-team`。
4. 检查 Codex 配置（默认是用户目录下的 `.codex/config.toml`），仅在缺失时加入
   `[features.multi_agent_v2]` 和 `enabled = true`，保留其他现有配置。
5. 不要向我索取或代填 DeepSeek API Key。安装完成后，让我亲自在
   Settings → Integrations → DeepSeek Subagent 中填写一组或多组独立的
   Base URL + API Key 连接、刷新模型并保存模型。
6. 提醒我保存模型后新建一个 Codex 任务，再用原生 DeepSeek 子智能体做一次测试；
   正常委派不应打开 Settings 页面。
7. 确认原生路由状态为“已就绪”。macOS 使用用户级 LaunchAgent；Windows 和
   Linux 使用无需管理员权限的用户级后台 router。任何平台都不得把启动成功当成
   委派成功，必须在新任务中完成一次真实的 DeepSeek 子智能体测试。
```

Direct Git marketplace commands / 直接使用 Git marketplace 的命令：

```sh
codex plugin marketplace add darkmice/codex-deepseek-subagent --ref main
codex plugin add deepseek-subagent@deepseek-team
```

## DeepSeek Team workflow / DeepSeek 团队模式

The plugin provides `$deepseek-team` for GPT-led execution. GPT owns planning,
architecture, security judgment, visual decisions, integration, and final QA;
native DeepSeek children handle suitable bounded implementation, testing,
debugging, documentation, research, and data-processing work. The existing
`deepseek-subagent` skill remains the lower-level contract for one explicit
native delegation.

插件提供 `$deepseek-team` 编排模式：GPT 负责规划、架构、安全判断、视觉决策、集成与
最终 QA；原生 DeepSeek 子智能体执行适合拆分的有界实现、测试、调试、文档、研究和数据
处理任务。现有 `deepseek-subagent` Skill 继续作为单次明确原生委派的底层契约。

Team mode is selected only for matching requests; it does not make DeepSeek the
root model or force every small task through a child. Delegated content may be
sent to DeepSeek, and GPT must inspect the real artifacts and rerun appropriate
verification before reporting completion. / 团队模式只在匹配的请求中使用，不会把
DeepSeek 设为根模型，也不会强制每个小任务都创建子智能体。委派内容可能发送给
DeepSeek；GPT 在报告完成前必须检查真实产物并重新验证。

## Manual install / 手动安装

1. Install Node.js 20+ and use the Codex binary bundled with the current
   desktop app, or a matching current CLI release. Older CLI builds may not
   understand the current Multi-Agent v2 and model-cache contracts. / 安装
   Node.js 20+，并使用当前 Codex 桌面版内置的 binary，或与其版本匹配的新版 CLI；
   旧 CLI 可能无法识别当前 Multi-Agent v2 与模型缓存契约。
2. Clone or extract this repository. / 克隆或解压本仓库。
3. Add the non-default marketplace and install the plugin:

   ```text
   codex plugin marketplace add <absolute-repository-path>
   codex plugin add deepseek-subagent@deepseek-team
   ```

   将 `<absolute-repository-path>` 替换为本仓库绝对路径。Windows 可使用
   `C:\...\codex-deepseek-subagent`。

4. On macOS, Windows, or Linux, enable Codex Multi-Agent v2 in the active
   `CODEX_HOME/config.toml` (normally `.codex/config.toml` under your user home):

   ```toml
   [features.multi_agent_v2]
   enabled = true
   hide_spawn_agent_metadata = false
   ```

   `enabled = true` is required. `hide_spawn_agent_metadata = false` is
   optional and only keeps spawn metadata visible. The plugin checks the v2
   prerequisite but does not rewrite global Codex config. Remove the obsolete
   root-level `multi_agent_v2.hide_spawn_agent_metadata` setting if present;
   current Codex releases reject it in strict config mode.
5. Start a Codex task, open **Settings → Integrations → DeepSeek Subagent**,
   add one or more Base URL + API key connections, refresh and save the model,
   then start one new task. Each connection has its own Base URL; new connections
   default to DeepSeek's official `/v1/` endpoint and may instead use a compatible
   HTTPS Responses API proxy. Saving the model installs a
   user-scoped router and a marked, reversible loopback provider route. macOS
   uses LaunchAgent; Windows and Linux use an authenticated detached process
   that requires no administrator privileges. / 先按第 4 步启用 Multi-Agent v2；
   再打开设置页添加一组或多组 Base URL + API Key 连接，刷新并保存模型。每组连接
   都有自己的 Base URL；新连接默认使用 DeepSeek 官方 `/v1/` 地址，也可改为兼容
   Responses API 的 HTTPS 代理。保存模型会安装用户级 router 与带标记、可恢复的
   本机 provider 路由；macOS 使用 LaunchAgent，Windows/Linux 使用无需管理员权限的
   受认证后台进程。随后新建一个任务。

The native routing integration supports macOS, Windows, and Linux and requires
a current Codex release with custom agents and native subagent workflows. The effective
provider becomes a loopback router: parent requests are forwarded to the
upstream resolved from the active ChatGPT-authenticated provider. The installer
also bridges the original provider ID to the same router, so reopened tasks that
still retain that provider ID cannot send `deepseek-*` directly to ChatGPT. The
native role selects the saved DeepSeek model; only a request carrying the exact
prepared task envelope is authorized and sent to DeepSeek.
Because Codex encrypts native collaboration message bodies for its ChatGPT
provider, the skill first uses the plugin's local control-plane tool to stage
the explicit DeepSeek delegation message in bounded, short-lived router memory.
That preparation call also checks readiness, so normal delegation does not call
or render the settings tool. The settings UI is reserved for explicit setup or
configuration changes, and for recovering from a failed readiness check.
The router returns a randomized task name; the skill immediately passes that
exact name and message to native `spawn_agent`, then substitutes the staged
plaintext for the opaque collaboration payload in the matching child request.
The MCP tool never calls a model. Missing, expired, or mismatched task state
fails closed instead of starting a child without its task.
Tool continuations remain bound to that same task: the router records only
in-memory HMAC digests of reasoning ciphertext observed in a successful
DeepSeek response, then accepts only the matching ciphertext in the next
request. It never stores the ciphertext itself; unknown, cross-task, malformed,
or misplaced encrypted content is rejected before any upstream request. If
Codex context compaction removes the original task envelope, the continuation
must carry a `previous_response_id` whose HMAC binding was committed from a
completed DeepSeek response. The generated model catalog declares a
1,000,000-token context window and reserves 5% for context management.
Related work can reuse an idle or terminal DeepSeek child. The parent first
calls `deepseek_followup_prepare`, then immediately calls native
`followup_task` with the same task path and message. The router binds the new
plaintext turn to the ordered encrypted history already committed for that
child. If that in-memory binding has expired, preparation fails closed and the
parent prepares one replacement child instead of retrying indefinitely.
Unstarted preparations and pending follow-ups expire after at most ten minutes.
For continuity, an active task's bounded plaintext turn history remains only in
router memory until 35 minutes idle or two hours absolute, whichever comes
first; it is never written to settings, runtime state, or logs.
Native child completion can race with the parent's next `wait_agent` call. If a
matching terminal event has already arrived, the parent consumes it without
waiting again. A wait timeout only means no new mailbox event arrived during
that interval; the parent reads the task-tree state before reporting failure.
The router also merges the plugin-generated DeepSeek metadata into the
authenticated parent `/models` response, so the parent keeps its official
catalog while `deepseek-flash` is registered as text-and-image capable.
Custom providers with unsupported routing or header fields are rejected rather
than silently changing their data path.

The settings page supports an ordered pool of up to eight independently enabled
connections. Each item is one inseparable Base URL + API key pair. Model discovery
uses the intersection reported by the currently available enabled connections.
Before any response bytes are forwarded, HTTP `401` isolates an invalid connection
and HTTP `402` temporarily skips a connection with insufficient balance, then the
router switches both endpoint and key to the next enabled item. It deliberately does not switch on `429`,
`5xx`, TLS/network errors, or timeouts: DeepSeek rate limits are account-scoped,
and replaying ambiguous failures can duplicate work. Once a task succeeds on a
connection, all of its tool continuations stay pinned to that same connection;
streaming output is never replayed after it starts. Exact concurrent or already
committed follow-up replays are rejected before another upstream execution. Provider
request buffering is derived from the router's V8 heap rather than the model context
window: the default single-request budget is at least 160 MiB and scales up to 1 GiB,
with a separate heap-derived global in-flight budget. Compressed inputs are bounded
after decompression, and `/healthz` reports the active byte budgets. If every eligible connection is unavailable, or
DeepSeek returns HTTP `413` before output begins, that task is permanently rebound to the
authenticated parent GPT provider and its original parent model. Existing schema v1/v2 single-key
settings and schema v3 shared-Base-URL pools migrate locally to schema v4 on the
next settings write without exposing the secret.

原生路由支持 macOS、Windows 与 Linux，并依赖支持 custom agents 与原生 subagent
workflow 的新版 Codex。生效后的 provider 是本机 loopback router：父任务转发至当前 provider
解析出的原上游；安装器也会把原 provider ID 桥接到同一路由，因此重新打开后仍保留旧
provider ID 的任务不会把 `deepseek-*` 直接发给 ChatGPT。原生 role 选择已保存的 DeepSeek
模型，只有携带精确预备任务 envelope 的请求才会获准发往 DeepSeek。若自定义
provider 含无法安全保留的路由或 header 字段，插件会拒绝启用，不会静默改变数据出口。
Codex 会按 ChatGPT provider 加密原生协作消息正文，因此 skill 会先通过插件的本地
控制面工具，把明确的 DeepSeek 委派消息短暂放入有容量与时限的 router 内存。
该预备调用也会检查就绪状态，因此正常委派不再调用或渲染设置工具。设置页只用于用户
主动配置，或在就绪检查失败后恢复配置。
router 返回随机唯一任务名，skill 随即把同一任务名与正文交给原生 `spawn_agent`。MCP 工具
不调用模型。router 再按唯一任务名匹配 child 请求并替换其中无法由 DeepSeek 解密的
协作 payload；状态缺失、过期或不匹配时直接失败。
工具续请求仍绑定同一 task：router 只在内存中记录成功 DeepSeek 响应里 reasoning
密文的 HMAC 摘要，下一次请求仅接受同一 task 已观察到的密文。router 不保存密文原文；
未知、跨 task、畸形或位置错误的加密内容会在出网前被拒绝。
若 Codex 上下文压缩移除了原始任务 envelope，续传请求必须携带已由成功 DeepSeek 响应
提交 HMAC 绑定的 `previous_response_id`。模型目录声明 1,000,000 tokens，并为上下文
管理保留 5%。
同一会话中的相关工作可复用 idle 或 terminal 的 DeepSeek child：父任务先调用
`deepseek_followup_prepare` 暂存新的有界正文，再立即用同一 task path 和正文调用原生
`followup_task`；router 将新正文绑定到该 child 已提交的有序加密历史。若内存绑定已经过期，
预备阶段会失败关闭，父任务只创建一个替代 child，不做无限重试。
未启动的预备和待处理 follow-up 最长十分钟后过期；为保持连续性，active task 的有界明文
轮次历史只保留在 router 内存中，在空闲 35 分钟或首次预备后两小时（以先到者为准）清除，
绝不写入设置、运行状态或日志。
原生 child 可能在父任务下一次调用 `wait_agent` 前已经完成。若对应终态事件已经到达，
父任务直接收口，不再重复等待；等待超时只表示该时间段没有新的 mailbox 事件，报告失败
前必须回读任务树中的真实状态。
路由还会把插件生成的 DeepSeek metadata 合并到父 provider 的 `/models` 响应中，父任务
保留官方模型目录，同时将 `deepseek-flash` 注册为 text+image 模型。

设置页支持最多 8 个可独立启停、可排序的连接；每一项都是不可拆分的一组
Base URL + API Key。模型发现取当前可用且已启用连接的模型交集。仅在尚未向 Codex
输出任何响应字节时，`401` 会隔离无效连接，`402` 会暂时跳过余额不足的连接，并将
地址和 Key 一起切换到下一个已启用连接；
`429`、`5xx`、TLS/网络错误和超时不会切换，因为 DeepSeek 限流按账户计算，重放不确定
失败还可能重复执行。任务一旦用某组连接成功，其工具续轮就固定使用同一组 Base URL
和 Key；流式输出开始后绝不重放，完全相同的并发或已提交 follow-up 会在再次请求上游前被拒绝。
provider 的缓冲预算根据 router 的 V8 heap 动态计算，而不是模型上下文窗口：默认单请求预算
至少 160 MiB、最高 1 GiB，另有独立的全局在途预算；压缩输入按解压后大小受限，`/healthz`
会报告当前字节预算。
当全部候选连接均不可用，或 DeepSeek 在尚未输出时返回 HTTP `413`，该任务会永久绑定回已认证的
父级 GPT provider 及其原模型。旧 schema v1/v2 单 Key 配置与 schema v3 共享地址
连接池会在下一次设置写入时迁移为 schema v4，不暴露密钥。

The loopback router binds only to `127.0.0.1`, never logs request bodies or
authorization headers, and replaces the parent authorization before a request
is sent to DeepSeek. DeepSeek response headers are normalized, error bodies are
replaced, and successful response streams are checked for the active Key before
returning to Codex, so a compatible proxy cannot reflect it into task output or
logs. A delegated provider payload may include the task message,
model context, tool definitions/results, and attachments. Deleting all keys
immediately disables DeepSeek and restores the previous provider for new tasks;
parent pass-through remains available for already-open tasks for up to ten
minutes. On macOS, a conflicting LaunchAgent path or registered label is left
untouched unless its exact plugin ownership and arguments can be verified. On
Windows and Linux, the router accepts shutdown only through its random local
capability and verifies the running instance before replacement. / 路由仅监听
`127.0.0.1`，不记录请求正文或认证头；发往 DeepSeek 前会替换
父任务授权。委派 payload 可能包含任务消息、模型上下文、工具定义/结果和附件。删除
Key 会立即禁用 DeepSeek、为新任务恢复原 provider，并为已打开任务保留最长十分钟的
父请求透传。macOS 上若固定 LaunchAgent 路径或 label 已被其他程序占用且无法验证插件
所有权，插件会保持原状并拒绝覆盖或停止该服务；Windows/Linux 只通过随机本机
capability 关闭 router，并在替换前验证运行实例。

The delegation control-plane call is part of normal Codex tool history, so its
arguments may be retained by Codex even though the router never writes the
message to settings, runtime state, or logs. Do not delegate secrets or data
that should not be sent to DeepSeek.

委派控制面调用属于正常 Codex 工具历史，因此即使 router 不把正文写入设置、运行状态
或日志，Codex 仍可能保留工具参数。不要委派不应发送给 DeepSeek 的密钥或敏感数据。

## Update / 更新

Pull or replace repository files, then reinstall from the configured local
marketplace with `codex plugin add deepseek-subagent@deepseek-team`. Open the
settings page, save the selected model again, and start a new task so Codex
regenerates and loads the refreshed router, native role, and skill.

拉取或替换仓库文件后重新执行安装命令；打开设置页再次保存模型，再新建任务，以重新
生成并加载新版 router、原生 role、skill 与 MCP server。

## Uninstall / 卸载

Before removing the plugin, either use **Delete key** in its settings page or
run the independently installed cleanup command for your platform below. The standalone copy is
written when a model is saved and still works if the plugin source has already
been removed:

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

The standalone command immediately stops the owned router service/process, restores the
previous Codex provider, and removes the credential, native role, router state,
and cleanup support files. Start a new Codex task, then uninstall the plugin.
It refuses to delete conflicting files whose plugin ownership cannot be
verified.

If the settings page reports that `settings.json` is damaged, close Codex,
make a private backup if needed, and remove only the DeepSeek Subagent
`settings.json` at the platform-specific location documented in the plugin
README. Reopen Settings to recreate it. If uninstalling, run cleanup again
after removing the damaged file. Never share the backup because it may contain
the API key.

卸载插件前，请先在设置页点击**删除全部 Key**，或执行上面的独立清理命令。保存模型时会把
该命令安装到用户设置目录，所以即使插件源码已经删除，它仍可执行。请按当前系统使用
上方对应命令。独立清理会立即停止插件所有的 router 服务或进程、恢复原 Codex provider，
并删除凭据、原生 role、router 状态和清理支持文件；随后新建 Codex 任务，再卸载插件。
无法验证插件所有权的冲突文件不会被删除。

如果设置页提示 `settings.json` 已损坏，请关闭 Codex；如确有需要先做私密备份，然后只
删除插件 README 所列平台目录中的 DeepSeek Subagent `settings.json`。重新打开设置页会
重建该文件；若正在卸载，请在删除损坏文件后再次运行清理命令。备份可能包含 API key，
不得分享。

## Package / 打包

For local development, the two installed skills can track this checkout
directly while the MCP server and assets remain managed by the normal plugin
installation:

```text
npm run link:local-skills
```

This replaces only the installed cache copies of `deepseek-team` and
`deepseek-subagent` with directory links to this repository. Run it again after
installing a new cache-busted plugin version, then start a new Codex task.

本地开发时，可让两个已安装 Skill 直接跟随当前 checkout，同时继续由正常插件安装管理
MCP server 与资源文件：运行 `npm run link:local-skills`。该命令只把安装缓存中的
`deepseek-team` 和 `deepseek-subagent` 替换为指向本仓库的目录软链接。安装新的
cache-busted 版本后需再运行一次，然后新建 Codex 任务加载。

From the repository root, run:

```text
node scripts/package.mjs
```

The dependency-free script writes
`dist/codex-deepseek-subagent-<version>.zip`. The archive contains the team
marketplace and plugin source, never user settings or API keys.

该零第三方依赖脚本输出 `dist/codex-deepseek-subagent-<version>.zip`，包内含团队
marketplace 与插件源码，不包含用户设置或 API key。
