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

1. Partition the request by dependency and ownership. Delegate only work that
   is non-trivial, self-contained, and likely to save meaningful time or API
   spend. Handle a trivial one-step task directly. Use the minimum useful
   number of children, and parallelize only independent work.
2. Give every child a bounded, self-contained message containing:
   - the concrete outcome and relevant context;
   - owned files or responsibility;
   - acceptance criteria and verification to run;
   - constraints, including that other work may be present in the shared
     workspace and must not be reverted or overwritten.
3. For each child, follow the sibling DeepSeek subagent skill exactly: prepare
   one delegation and immediately spawn its matching native child before
   preparing another. Use the returned randomized task name, `agent_type:
   "deepseek"`, no model override, and `fork_turns: "none"`.
4. While independent children run, continue only GPT-owned work that cannot
   conflict with their file ownership. Follow each child to a terminal state
   using the native collaboration workflow.
5. Treat child reports as leads, not proof. GPT inspects the actual files,
   diffs, logs, and other artifacts; integrates compatible results; reruns
   risk-proportionate verification; and corrects defects before reporting
   completion.

If a child needs more work, either fix it in the GPT parent or prepare and
spawn a fresh bounded DeepSeek child as required by the native delegation
protocol. Do not assume a timed-out wait means failure, and do not claim that a
spawned or successful child alone completes the user's task.

If DeepSeek readiness fails, finish any safe GPT-owned analysis and report the
specific setup blocker. Do not silently substitute GPT execution for work that
the user explicitly selected DeepSeek to perform.

## Final QA

Before answering the user, GPT verifies the original requirements one by one,
checks for regressions and unrelated changes, and distinguishes verified work
from anything that could not be tested. Do not repeat benchmark ratios or
promise a fixed cost saving; actual latency and spend depend on the delegated
work and provider pricing.
