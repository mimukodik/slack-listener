# One listener in three languages

**The question:** when a fresh coding agent makes a maintenance change to the listener, which language gets it to a correct, accepted change fastest: TypeScript on Effect, Rust or Zig?

**Why these three:**

- **TypeScript with [Effect](https://effect.website/docs/getting-started/the-effect-type/)** is the working listener. Its services let the same program run against real Slack or the simulated world.
- **Rust** [checks ownership and borrowing at compile time](https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html), which gives an agent fast, precise feedback.
- **Zig** makes memory and capacity explicit and checks less at compile time: the programmer keeps track of [how long each piece of memory lives](https://ziglang.org/documentation/0.16.0/#Lifetime-and-Ownership).

Our hypothesis is that a bounded Zig design lets an agent iterate faster, and that this can outweigh Rust's extra compile-time checks. The bar was fixed before any port began: per accepted change, Zig must take at most 70% of Rust's time, accept at least as many changes, and show no critical failure. The [protocol](measurement/PROTOCOL.md) gives the measures, the schedule and the scoring.

## What every implementation must do

All three follow the same contract:

- the [listener rules](https://github.com/mimukodik/slack-listener/blob/3a36ac759c5fccb0456b17121b81b6a6716a1aff/RULES.md) and the [English specification](https://github.com/mimukodik/slack-listener/blob/3a36ac759c5fccb0456b17121b81b6a6716a1aff/docs/en/specification.md), frozen at `3a36ac7`;
- the TypeScript listener at the same commit as the reference implementation.

The task hub is not part of this comparison.

What gets compared is what the outside world sees: deliveries to the session, acknowledgements to Slack, reactions, and what survives a restart. Internal traces may differ between languages. Each port must keep decisions in a core that does no I/O and must bound its pending work. It must also state what happens when a bound is reached, and record its choices about memory, ownership and threads.

## Where it stands (2026-11-24)

**Nothing is scored yet.** Both new ports were built by agents (Codex CLI 0.172.0, the same model and settings for both), dispatched together from `f522128`. The launch prompts and their SHA-256 digests are in the [dispatch record](runs/construction/dispatch.json). Both first launches failed inside a nested macOS sandbox and resumed in a different one. A construction ledger records every attempt, including the failed ones.

| Arm                 | State                  | What its own checks show                                                                                                                                                                                                                                | Not yet shown                                                                        |
| ------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| TypeScript / Effect | Reference, `3a36ac7`   | The full simulator, the exhaustive pass and the TLA+ replay ([history](../../history/arch-poc/README.md))                                                                                                                                               | The common acceptance gate below                                                     |
| Rust                | Local commit `285a31f` | Entry-point tests (11 at the last check) that run the native binary against fake Slack and session peers on the local machine, in both debug and release builds. Two deliberately broken versions are rejected (admitting every sender, admitting none) | Live Slack, credentials, saved state read by the TypeScript version, the common gate |
| Zig                 | Local commit `3c2ddab` | Two test suites drive the binary through fake Slack and session peers on the local machine. Two deliberately broken versions are rejected (a sender leak, a missing `possible_duplicate`)                                                               | The same, plus the optional raw-frame recorder and one retry case for session writes |

These are construction results: each builder checked its own work. They show the ports run. They are not the acceptance evidence the comparison needs. The ledgers will be published with the ports.

**Shared build caching** (kache) is infrastructure for sandboxes and CI and is outside this experiment. An early version of the protocol required it, and [the protocol amendment](measurement/PROTOCOL.md#amendment-before-scored-runs) records the correction.

## What has to happen before the scored trial

1. **An independent common baseline gate.** One set of acceptance checks, written by someone who built none of the ports, runs against all three arms through their production entry points. Before anyone relies on the gate, it has to reject planted wrong behaviour.
2. **Freeze everything, then publish its digest.** The three task prompts, the held-back checks with their expected results, and the scoring code are sealed, and their SHA-256 digests are committed before any agent sees a task.
3. **Then dispatch.** 18 attempts: three tasks, two repetitions, three languages. Each attempt gets a fresh agent, a 45-minute budget and the same model. [The scorer](measurement/score.py) refuses an incomplete or duplicated cohort.

## Open design questions

- **What must a Zig edit keep, and how do we prove it kept it?** The Zig port allocates memory while it runs, sizes its arenas by job, and runs I/O tasks beside one loop that owns the state (its README's design section records this). Rust's compiler enforces ownership and sharing between threads. In Zig, nothing stops a maintenance edit from breaking these. The gate needs checks that fail on a planted ownership or sharing bug in Zig, or the comparison credits Zig for speed and never charges it for safety.
- **Can a good total hide a failed task family?** The pilot bar counts accepted changes across all three tasks. A port could fail every attempt at, say, the recovery task and still meet the bar on the other two. The protocol requires all three task families to be represented but sets no minimum per family. Whether to add one has to be decided before the freeze, not after the results.

## What a result would and wouldn't show

A pass would show the result for this one listener workload, on one machine, with one model. It would justify repeating the trial on another workload. It wouldn't prove memory safety in general, and it wouldn't choose a language for desktop, mobile or the web. Each of those needs its own registered study on its own target.
