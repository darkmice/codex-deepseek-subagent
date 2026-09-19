---
name: deepseek-team
description: Coordinate non-trivial work with GPT as planner, architect, safety reviewer, visual lead, and final QA while native DeepSeek child tasks execute bounded implementation work. Use when the user asks for DeepSeek Team, GPT-led DeepSeek execution, or an Astra and DeepSeek collaboration workflow.
---

# GPT-led DeepSeek team

Use GPT as the accountable lead and DeepSeek as the fast, cost-efficient
executor. This skill defines the division of work; the sibling
[DeepSeek subagent skill](../deepseek-subagent/SKILL.md) owns the native
delegation protocol and must be read before the first child is prepared.

Do not activate this team workflow for unrelated requests. Delegation is a
means to complete the user's task, not an outcome by itself.

## Divide responsibility

Keep these responsibilities with the GPT parent:

- clarify the goal and inspect enough source-of-truth evidence to plan safely;
- architecture, cross-component contracts, and consequential trade-offs;
- security, privacy, credential, permission, and irreversible-operation
  decisions;
- visual interpretation and visual quality decisions;
- integration, adversarial review, final QA, and the user-facing conclusion.

Prefer DeepSeek children for bounded execution such as implementation,
refactoring, test authoring, routine debugging, documentation, research, and
data processing. For work with security or architectural consequences, GPT
first defines the design and invariants, DeepSeek may implement the bounded
change, and GPT then reviews it against those invariants.

Do not delegate secrets, credential handling, production writes, release
approval, destructive actions, or final security decisions. Send only the
minimum context that the child needs because delegated content may be sent to
DeepSeek.

## Orchestrate the work

1. Start with a conversation-level DeepSeek roster. Call `list_agents` before
   preparing any new child, remember the task path and responsibility of each
   DeepSeek child already created in this parent conversation, and prefer the
   existing child whose responsibility and trust boundary match the next work.
   Use one primary DeepSeek coding executor by default. Do not have more than
   two DeepSeek children working concurrently or create more than three unique
   DeepSeek children in one parent conversation unless the user explicitly
   requests broader parallelism.
2. Partition the request by dependency and ownership. Delegate only work that
   is non-trivial, self-contained, and likely to save meaningful time or API
   spend. Handle a trivial one-step task directly. Use the minimum useful
   number of children, and parallelize only independent work.
3. Reuse before spawning:
   - if a matching DeepSeek child is idle or terminal, send the next bounded
     assignment by calling `deepseek_followup_prepare` and then immediately
     `followup_task` with that exact task path and the same message; do not call
     `deepseek_delegation_prepare` or spawn another child;
   - if it is still working, wait for it; do not use `send_message`, prepare a
     follow-up, or create a duplicate worker for the same responsibility;
   - rely on the reused child's task history for continuity, but restate changed
     requirements, acceptance criteria, and source-of-truth locations instead
     of assuming its earlier view of the workspace is still current.
4. Give every new child or follow-up a bounded, self-contained message containing:
   - the concrete outcome and relevant context;
   - owned files or responsibility;
   - acceptance criteria and verification to run;
   - constraints, including that other work may be present in the shared
      workspace and must not be reverted or overwritten.
5. Only when no existing child is safely reusable, follow the sibling DeepSeek
   subagent skill exactly: prepare
   one delegation and immediately spawn its matching native child before
   preparing another. Use the returned randomized task name, `agent_type:
   "deepseek"`, no model override, and `fork_turns: "none"`.
   Choose a readable preparation base name before the router adds its security
   suffix: use two to four concise `snake_case` words describing domain and
   outcome, such as `router_binding_fix`, `checkout_ui_test`, or
   `api_contract_review`. Do not use generic names such as `task1`, `worker_a`,
   `deepseek_job`, timestamps, or raw identifiers. The randomized suffix must
   remain unchanged; the readable prefix is the stable name shown in the task
   tree and reused by later follow-ups.
   A fresh child is justified only for independent parallel ownership, a
   materially different trust or permission boundary, deliberate context
   isolation, or an unavailable/expired/failed existing child. A
   `TASK_BINDING_REQUIRED` follow-up means that child's router binding can no
   longer be reused: prepare and spawn one replacement, update the roster, and
   do not retry the same failed follow-up repeatedly.
6. While independent children run, continue only GPT-owned work that cannot
   conflict with their file ownership. Follow each child to a terminal state
   using the native collaboration workflow.
7. Treat child reports as leads, not proof. GPT inspects the actual files,
   diffs, logs, and other artifacts; integrates compatible results; reruns
   risk-proportionate verification; and corrects defects before reporting
   completion.

If a child needs more work, either fix it in the GPT parent or reuse the same
child with the follow-up preparation sequence above. Spawn a replacement only
when the reuse rules say it is not safe or available. Do not assume a timed-out
wait means failure, and do not claim that a spawned or successful child alone
completes the user's task.

If DeepSeek readiness fails, finish any safe GPT-owned analysis and report the
specific setup blocker. Do not silently substitute GPT execution for work that
the user explicitly selected DeepSeek to perform.

## Final QA

Before answering the user, GPT verifies the original requirements one by one,
checks for regressions and unrelated changes, and distinguishes verified work
from anything that could not be tested. Do not repeat benchmark ratios or
promise a fixed cost saving; actual latency and spend depend on the delegated
work and provider pricing.
