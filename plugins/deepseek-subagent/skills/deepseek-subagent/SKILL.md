---
name: deepseek-subagent
description: Delegate a bounded task to a native Codex child task running on DeepSeek when the user explicitly asks for DeepSeek, a DeepSeek subagent, or a DeepSeek second opinion.
---

# DeepSeek native subagent

Use this skill only when the user explicitly requests DeepSeek or a DeepSeek
subagent. The MCP server manages settings and a loopback delegation control
plane; it never calls a model or executes the delegated task.

## Native delegation

1. Call `deepseek_delegation_prepare` first with a short base `taskName`, the
   exact bounded `message`. This stages the plaintext only in bounded,
   short-lived router memory and returns a randomized task name.
   Make the base name human-readable because it becomes the visible prefix in
   the native task tree: use two to four concise lowercase `snake_case` words
   describing domain and outcome, for example `router_binding_fix` or
   `api_contract_review`. Do not use `task1`, `worker_a`, `deepseek_job`, a
   timestamp, or an opaque identifier. Preserve the router-generated suffix
   exactly when spawning; it provides uniqueness and task-binding entropy.
   `deepseek_delegation_prepare` is also the readiness gate: it verifies the
   credential, selected model, native integration, runtime files, and router
   endpoint before staging anything. Do not call `deepseek_settings` before a
   normal delegation; that tool renders the settings UI and is only for a user
   who explicitly asks to view or change settings. If preparation reports that
   setup is missing or not ready, direct the user to **Settings → Integrations
   → DeepSeek Subagent** (and open/read `deepseek_settings` only when useful
   for that setup flow). Ensure Codex config contains
   `[features.multi_agent_v2]` with `enabled = true`, save a model, and start a
   new Codex task. `hide_spawn_agent_metadata = false` in that table is optional
   and only controls metadata visibility. Saving the model installs a marked,
   reversible loopback provider route for the next task. Parent traffic remains
   on the upstream resolved from its active ChatGPT-authenticated provider.
   A child request carrying the exact prepared task envelope is rerouted to the
   selected DeepSeek model. The installer also bridges the original provider ID
   to the loopback route, so a reopened task that retains that provider ID cannot
   send a DeepSeek model ID directly to ChatGPT.
   unsupported custom provider routing/header fields fail closed.
   Do not reuse the base name or invent a suffix.
2. Immediately call Codex's native `spawn_agent` with:
   - `agent_type: "deepseek"`. The settings page installs this agent role;
     Multi-Agent v2 discovers the role and exposes it to new tasks.
   - no `model` override. The plugin-managed native `deepseek` role owns the
     selected DeepSeek model; the startup router authorizes only the matching
     prepared child request.
   - `fork_turns: "none"` on Multi-Agent v2. Cross-provider history is
     intentionally excluded so the child starts with only the delegated task.
   - the exact randomized `task_name` returned by
     `deepseek_delegation_prepare` and the same bounded, self-contained
     `message`.
   - only the minimum context required. The delegated task, child model context,
     tool definitions/results, and attachments in that request may be sent to
     DeepSeek.
3. Follow the native child to a terminal state. The child appears in the normal
   Codex task tree and streams status through the normal UI.
   - If the matching child `FINAL_ANSWER`, error, or terminal completion event
     has already arrived after `spawn_agent`, consume it directly and do not
     call `wait_agent`; the child is already terminal.
   - Otherwise call native `wait_agent` with a bounded timeout.
   - A `wait_agent` timeout means only that no new mailbox event arrived during
     that wait. It is not proof that the child failed. Read the matching task
     with `list_agents`: consume a terminal result if present, or wait again
     only while its state is still working.
   To continue related work after the child becomes idle or terminal, first
   confirm its task still exists with `list_agents`. Call
   `deepseek_followup_prepare` with that exact task path and the new bounded
   message, then immediately call `followup_task` with the same task path and
   message. Do not use `deepseek_delegation_prepare` or `spawn_agent` for a
   reused child. The follow-up preparation stages only the new plaintext turn;
   the router verifies the ordered encrypted history already committed for that
   child, so the child keeps its native task history without receiving the
   parent's full history. Never prepare more than one pending follow-up. If
   preparation or the follow-up fails with `TASK_BINDING_REQUIRED`, the
   in-memory binding expired or became unavailable; prepare and spawn one fresh
   bounded child instead of retrying the same follow-up. Tool continuations and
   context compaction within a running child use the same committed provenance.

Do not set any API model ID directly in `spawn_agent`; DeepSeek model selection belongs
to the settings page, managed role, and router. Do not request a full-history fork and
do not fall back to hidden `codex exec` workers.

The delegated message is sent to DeepSeek and may also be retained by Codex as
normal task/tool history. An unstarted preparation or pending follow-up expires
after at most ten minutes. Once a task is active, the router keeps its bounded
plaintext turn history only in memory for continuity, expiring it after 35
minutes idle and no later than two hours after initial preparation; it never
writes that history to its runtime file or logs. Never prepare a message unless
the next action is the matching native collaboration call.

## Parent responsibilities

The DeepSeek child is an implementation assistant, not the source of truth.
After it returns, inspect the actual files or diff, re-run verification, and
correct defects before reporting completion. Do not delegate secrets,
credential handling, irreversible operations, production writes, security
decisions, or final release approval unless the user explicitly scopes that
work and the normal approval boundary remains in place.

Never ask the user to paste an API key into chat or put it in a shell command.
