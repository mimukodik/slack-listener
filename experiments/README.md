# How should we build software with coding agents?

We want to choose development practices for Agent Native, a framework for apps built with coding agents. The question is whether an agent can change an app quickly and preserve the behavior people rely on.

- **Keep using replayable tests.** Simulation found four bugs before the first live run. A model built from the rules later exposed a reaction the listener removed too early.
- **Drop the tested swarm configuration.** Turning off about half the possible actions and faults made 18 of 19 planted bugs harder to detect per second.
- **Keep the language choice open.** We are building the same listener in Rust and Zig alongside the working TypeScript/Effect version. The scored maintenance comparison is still ahead.

The listener wakes an agent session when an allowed sender posts on Slack. Imagine a laptop sleeping halfway through delivery. On wake, the listener must recover the message and account for the possibility that the session already saw it. That makes a small tool a useful test of timing, storage and recovery. The **task hub** is a separate tool that tracks who holds a task and whom it is waiting for. Some earlier tests exercised both; the language trial uses the listener. [Listener behavior rules](../RULES.md) · [Task hub model](../spec/tasks/README.md)

## Which approaches earned their place?

### TigerStyle and a decision core

Put limits on queues, state what must always hold, and let a small core decide what to do. An outer layer talks to Slack, the clock and storage. The shell passes the time into the TypeScript core. A lint check rejects an accidental direct clock read that TypeScript alone would permit. A bounded queue also needs an explicit decision about what happens when it fills. [Practices and their checks](../PRINCIPLES.md)

### Deterministic simulation and property-based testing

Generate many sequences of events. Check a rule after each step. Save the random seed so the same sequence and timing can be replayed. The early simulator found four core bugs before the first live run, including an edit lost during crash recovery. The later simulator also checked the session's actual output. Its blind spot is the fake world: a deliberately shortened retention window went undetected because sampled runs ended before the pruning path ran. [What simulation caught](../DECISIONS.md#2026-11-17-the-method-and-what-it-gave) · [What it missed](../history/arch-poc/swarm/mutants.md)

### Model checking with TLA+

Describe the allowed states and transitions from the written rules, then let a checker explore the possibilities within chosen limits. A counterexample exposed a real bug. If adding the ✅ handled mark repeatedly failed, the listener still removed the 👀 seen mark. The fix keeps 👀. This method can expose an ambiguous rule before implementation, but checking a simplified model leaves a separate job: reproduce the failure in the real code. [Model, findings and limits](../spec/listener/README.md) · [Fix and replay](https://github.com/mimukodik/slack-listener/commit/667a7b300f820749b02e22be90ea78d2ca4fbd6b)

### Swarm testing

Randomly leave out some actions for an entire run. A simpler run might reach a state that ordinary traffic rarely visits. We dropped the half-off configuration on both workloads. It exposed 18 of 19 planted bugs less often per second. Many failures needed several actions together. The exception was a bug in handling malformed session input. Swarm exposed it about 28% more often per second. [Experiment, decision and evidence](../history/arch-poc/swarm/README.md)

How much weight should these results carry? A **planted bug** is an intentional wrong edit. Seeing a check reject that edit demonstrates one failure it can detect. A **bounded exhaustive pass** tries every allowed event sequence up to a stated length. The listener passed 680,613 sequences up to seven actions in the historical run. Longer sequences and faults absent from the simulated world remain open. [Historical checkpoint and unresolved work](../history/arch-poc/README.md)

## Which language makes the next correct change cheaper?

TypeScript with Effect gives us a working reference and a way to supply real or simulated services to the same code. Rust checks ownership and borrowing at compile time. Zig lets us make storage and capacity explicit; the programmer is responsible for how long a reference stays valid. Our hypothesis is that faster iteration in a bounded Zig design could outweigh the additional feedback Rust gives an agent. We have no scored language result yet. [Effect's service requirements](https://effect.website/docs/getting-started/the-effect-type/) · [Borrowing in Rust](https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html) · [Lifetimes in Zig](https://ziglang.org/documentation/0.16.0/#Lifetime-and-Ownership)

The ports will give us comparable starting points. Once all three pass the same acceptance checks, fresh agents receive the same unseen maintenance tasks. For Zig to pass the pilot, its time per accepted change must be at least 30% lower than Rust’s. It must deliver at least as many correct submissions and have zero observed critical failures. A failed attempt costs the full 45-minute budget in the calculation. This tests the listener workload. Reuse on desktop, mobile and the web still needs a run on each host, including WebAssembly where appropriate. [Study scope](listener/README.md) · [Metrics and scoring rules](listener/measurement/PROTOCOL.md)

## Where the ideas came from

- **For the design discipline**, start with TigerBeetle's rules on memory, bounds and assertions. [TigerStyle guide](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md#safety)
- **For testing a real program in a simulated world**, FoundationDB explains how repeatable timing and faults make rare failures reproducible. For a shorter introduction to generating inputs and shrinking a failure to a small example, read fast-check. [FoundationDB simulation](https://apple.github.io/foundationdb/testing.html) · [Property-based testing](https://fast-check.dev/docs/introduction/what-is-property-based-testing/)
- **For checking a design before writing it**, Leslie Lamport introduces the TLA+ modeling language and the TLC checker. [A High-Level View of TLA+](https://lamport.azurewebsites.net/tla/high-level-view.html)
- **For why leaving features out can sometimes help**, the original swarm paper gives the example of a stack that rarely fills when tests keep removing items. That was the motivation for trying it here. [Groce et al., Swarm Testing](https://www.flux.utah.edu/paper/groce-issta12/)

For the tooling decisions, the team kept the Effect-aware checker after a candidate linter accepted a planted error: an Effect was created but never run. Switching to Bun improved some timings and slowed others. The dated log gives the commands, versions and individual measurements. A proposed comparison of tools for shrinking a failure to a readable example remains open in the historical plan. [Tooling measurements](../DECISIONS.md#2026-11-21-the-simulator-on-bun-ber-2338) · [Original plan and open experiments](../history/arch-poc/plan.md)
