# What the architecture proof of concept established

The historical subject was a working Slack-to-session listener. The team first simulated its pure event core, then the full Effect program with virtual time, scheduling, Slack, session output and storage. The task hub added a separate exercise in transaction, lease and idempotency semantics. The listener comparison uses only the listener.

| Record | How to use it |
| --- | --- |
| [Complete plan at the pause](plan.md) | Scope, design, tooling, stages, planned experiments and their original bars, measurements, risks, open decisions and sources. Recovered from the coordinator's saved November 23 read-back. |
| [Dated implementation decisions and measurements](https://github.com/mimukodik/slack-listener/blob/3a36ac759c5fccb0456b17121b81b6a6716a1aff/DECISIONS.md) | The source log includes failed designs, changing checks, Bun/Node timing, one-pass type-aware lint, deterministic scheduling, exhaustive testing and simulator costs. Read the dated entry with its build, machine and sampling conditions. |
| [Engineering practices and enforcement](https://github.com/mimukodik/slack-listener/blob/3a36ac759c5fccb0456b17121b81b6a6716a1aff/PRINCIPLES.md) | Maps principles to actual checks and their gaps. |
| [Listener models](https://github.com/mimukodik/slack-listener/tree/3a36ac759c5fccb0456b17121b81b6a6716a1aff/spec/listener) and [task models](https://github.com/mimukodik/slack-listener/tree/3a36ac759c5fccb0456b17121b81b6a6716a1aff/spec/tasks) | TLC configs, planted faults, model scope and replay commands. The listener model exposed R18's given-up transition. Hub replay runs in CI; listener model checking was local. |
| [Swarm experiment](swarm/README.md) | Preregistered brief and mutations, per-seed measurements, coverage, analysis tools, rejected approach and blind spots. |

## Checkpoint and unfinished work

At baseline 3a36ac7 the session reported 2,000 listener seeds, 680,613 exhaustive prefixes at depth 7 and 1,367 hub model replay paths. These are historical results. Reproduce with the pinned package scripts and dependencies in the baseline. The tests exercise a synthetic world; shared defects in its model and checker can escape.

At the November 23 pause the swarm change had been built and then removed. Its measurement record was on a separate branch awaiting review. Two unreached mutations pointed to a live resend and a 24-hour pruning boundary. The plan then called for a timeboxed Hegel shrinking comparison, implementation steps 4d–4h, faults, clock jumps, deadlines, keepalive and crash points in steps 5a–5e, then shrinking. Hub B2/B3/C and upstreaming the scheduler patch remained open. The plan retains the exact order, trial limits and decisions that needed an owner. This checkpoint gives no result for those future experiments.
