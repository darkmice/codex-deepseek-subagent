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
4. 在 macOS 上检查 `~/.codex/config.toml`，仅在缺失时加入
   `[features.multi_agent_v2]` 和 `enabled = true`，保留其他现有配置。
5. 不要向我索取或代填 DeepSeek API Key。安装完成后，让我亲自在
   Settings → Integrations → DeepSeek Subagent 中填写 Key、刷新模型并保存模型。
6. 提醒我保存模型后新建一个 Codex 任务，再用原生 DeepSeek 子智能体做一次测试；
   正常委派不应打开 Settings 页面。
7. 如果当前系统不是 macOS，明确说明设置、连接测试和模型发现仍可使用，
   但原生 DeepSeek 子智能体路由目前不可用。
```

Direct Git marketplace commands / 直接使用 Git marketplace 的命令：

```sh
codex plugin marketplace add darkmice/codex-deepseek-subagent --ref main
codex plugin add deepseek-subagent@deepseek-team
```

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

4. On macOS, enable Codex Multi-Agent v2 in `~/.codex/config.toml`:

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
   save the key and model, then start one new task. Saving the model installs a
   user LaunchAgent and a marked, reversible loopback provider route. / 先按第
   4 步启用 Multi-Agent v2；再打开设置页保存 key 和模型。保存模型会安装用户级
   LaunchAgent 与带标记、可恢复的本机 provider 路由，随后新建一个任务。

The native routing integration currently supports macOS and requires a current
Codex release with custom agents and native subagent workflows. The effective
provider becomes a loopback router: parent requests are forwarded to the
upstream resolved from the active ChatGPT-authenticated provider, while
requests whose model matches the selected DeepSeek model are sent to DeepSeek.
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
or misplaced encrypted content is rejected before any upstream request.
Current encrypted follow-up envelopes do not expose a safe per-message binding,
so additional work is delegated by preparing and spawning a fresh bounded child.
Native child completion can race with the parent's next `wait_agent` call. If a
matching terminal event has already arrived, the parent consumes it without
waiting again. A wait timeout only means no new mailbox event arrived during
that interval; the parent reads the task-tree state before reporting failure.
The router also merges the plugin-generated DeepSeek metadata into the
authenticated parent `/models` response, so the parent keeps its official
catalog while `deepseek-flash` is registered as text-and-image capable.
Custom providers with unsupported routing or header fields are rejected rather
than silently changing their data path.

原生路由目前支持 macOS，并依赖支持 custom agents 与原生 subagent workflow 的
新版 Codex。生效后的 provider 是本机 loopback router：父任务转发至当前 provider
解析出的原上游；请求模型与所选 DeepSeek 模型一致时才会发往 DeepSeek。若自定义
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
当前加密 follow-up envelope 没有可安全绑定的逐消息标识；追加工作需重新预备并创建
新的有界 child。
原生 child 可能在父任务下一次调用 `wait_agent` 前已经完成。若对应终态事件已经到达，
父任务直接收口，不再重复等待；等待超时只表示该时间段没有新的 mailbox 事件，报告失败
前必须回读任务树中的真实状态。
路由还会把插件生成的 DeepSeek metadata 合并到父 provider 的 `/models` 响应中，父任务
保留官方模型目录，同时将 `deepseek-flash` 注册为 text+image 模型。

The loopback router binds only to `127.0.0.1`, never logs request bodies or
authorization headers, and replaces the parent authorization before a request
is sent to DeepSeek. A delegated provider payload may include the task message,
model context, tool definitions/results, and attachments. Deleting the key
immediately disables DeepSeek and restores the previous provider for new tasks;
parent pass-through remains available for already-open tasks for up to ten
minutes. A conflicting LaunchAgent path or registered label is left untouched
unless its exact plugin ownership and arguments can be verified. / 路由仅监听
`127.0.0.1`，不记录请求正文或认证头；发往 DeepSeek 前会替换
父任务授权。委派 payload 可能包含任务消息、模型上下文、工具定义/结果和附件。删除
Key 会立即禁用 DeepSeek、为新任务恢复原 provider，并为已打开任务保留最长十分钟的
父请求透传。若固定 LaunchAgent 路径或 label 已被其他程序占用且无法验证插件所有权，
插件会保持原状并拒绝覆盖或停止该服务。

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
run the independently installed cleanup command below. The standalone copy is
written when a model is saved and still works if the plugin source has already
been removed:

```sh
node "$HOME/Library/Application Support/DeepSeek Subagent/cleanup.mjs"
```

The standalone command immediately stops the owned LaunchAgent, restores the
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

卸载插件前，请先在设置页点击**删除 Key**，或执行上面的独立清理命令。保存模型时会把
该命令安装到用户设置目录，所以即使插件源码已经删除，它仍可执行。独立清理会立即停止
插件所有的 LaunchAgent、恢复原 Codex provider，并删除凭据、原生 role、router 状态和
清理支持文件；随后新建 Codex 任务，再卸载插件。无法验证插件所有权的冲突文件不会被
删除。

如果设置页提示 `settings.json` 已损坏，请关闭 Codex；如确有需要先做私密备份，然后只
删除插件 README 所列平台目录中的 DeepSeek Subagent `settings.json`。重新打开设置页会
重建该文件；若正在卸载，请在删除损坏文件后再次运行清理命令。备份可能包含 API key，
不得分享。

## Package / 打包

From the repository root, run:

```text
node scripts/package.mjs
```

The dependency-free script writes
`dist/codex-deepseek-subagent-<version>.zip`. The archive contains the team
marketplace and plugin source, never user settings or API keys.

该零第三方依赖脚本输出 `dist/codex-deepseek-subagent-<version>.zip`，包内含团队
marketplace 与插件源码，不包含用户设置或 API key。
