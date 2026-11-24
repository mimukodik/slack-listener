# Architecture experiment plan at the November 23 pause

Recovered from the final saved plan read-back at 2026-11-23T10:21:45.165Z. All 59 content blocks are represented in order. Diagram captions are rendered as text. Personal references are generalized. Status labels describe the historical checkpoint.

🔗 **Rests on:** BER-2169, the [slack-listener repository](https://github.com/mimukodik/slack-listener), [PRs #1–#20](https://github.com/mimukodik/slack-listener/pulls?q=is%3Apr+is%3Amerged) and [PRINCIPLES.md](https://github.com/mimukodik/slack-listener/blob/main/PRINCIPLES.md).

🎯 **Goal:** test as big a part of the application as possible, and start the actual experimentation with Tiger Style and deterministic simulation testing, while the working tool stays usable.

📌 **⏸️ PAUSED 2026-11-23 at a resting point:** main is 3a36ac7 (step 4c+). Swarm testing (method 3) is measured and dropped, and its record waits for review and a PR on the branch the swarm experiment branch. Resume from that PR, then Hegel (method 4).

## ⚡ 0. In short

🧵 **Phase 1, the steel thread, is done and in daily use.** A pure core, a shell, a seeded simulator against a fake Slack and a bounded exhaustive pass; a post, a reply and an edit reach the session once on real Slack, and the simulator found four core bugs before any live run (section 4.1).

🦶 **Phase 2 got our feet wet with the tooling and the approach.** PRINCIPLES.md and the stricter lint landed, then the simulation runtime, whose self-test replays 200 seeds, half with a crash, identically with no real timer (PR #5, PR #6, S2).

💡 **The first steps corrected the design.** Effect resumes a waiting fiber directly, so the seed orders the tasks and timers due together and cuts a busy fiber's turn, and fakes answer through the asking process's timers (F10).

🏗️ **Phase 3 tests the full architecture.** The listener program runs under the simulator from start-up on, in steps 1b to 6, with 3b to 3e added along the way (section 5).

🧰 **The tooling is Effect's patched tsrs, in one lint pass.** Oxlint's rules, the type check and Effect's rules, maintained by the Effect team, run on one build; no fork, no overlay of our own, no second checker (D4).

🔌 **Effect and the thin Slack client stay; patched globals are only a guard.** Effect's services are the main seam. The client already reconnects after 5 minutes of silence; whether it also needs a ping/pong keepalive is measured in step 5 (D1, D2, D3, F12).

🟢 **The live tool keeps working throughout.** Step 2 was checked live on real Slack before bob-check restarted on it, and R18's final version passed its live check on 2026-11-21, on Bun (G4, BER-2242).

✅ **Step 1b landed: Effect's rules run in one lint pass.** Today's code had no hit on the rules turned on, and twelve planted violations, for four Effect rules, six oxlint rules and the two tsconfig flags, each fail lint (S7).

✅ **Step 2 landed: the shell is one Effect program over services.** The review caught a dead fiber that went unnoticed and a demo that hung, both fixed before merge (PR #9); on real Slack a post, a reply and an edit each reached the session once.

✅ **Step 3 landed: the simulator runs the whole listener program.** Only the world is fake; three planted shell bugs are caught in 86.5–99.95% of seeds, at 5.6x the cost per run, and the exhaustive pass took about 6 minutes in CI until step 3b (PR #10, S1, S3).

✅ **Step 3b landed: the exhaustive pass is fast again.** Promise callbacks drain synchronously, only valid sequences run, and the pass is split across cores. Passing runs give the same results; a failing run now stops at its first failure, so its counts differ (S1).

✅ **Step 3c landed: three optimisations, measured one by one.** The 2000 seeds run on the worker pool, skipping repeated states is put off because it would save 5.9%, and a run's fixed cost dropped 15–20% (S8, S9, P7).

✅ **Step 3d landed: the exhaustive pass answers, marks done and fails calls.** Six of eight R18 bugs it missed now fail it at depth 2–4; the other two need a crash between done and the save, which the sampled pass catches. Depth 7 grew from 88,025 to 680,613 sequences, 260 s in CI (PR #18, S1).

✅ **The strict condition rules are on.** Their eleven hits are fixed, three of them type gaps, with every seed's result unchanged (PR #19, P9).

🧠 **For now the program's state stays in Effect, and sequences are replayed.** The copyable plain-data store is dropped. Copying by process fork or a machine snapshot comes back at the first real agent-native workflow (G6).

♾️ **The experiment has no end point and no time budget.** Its scope is expected to grow toward testing agent-native (G8).

🥟 **The listener runs on Bun.** Bun 1.4.5 is the only runtime and toolchain, with every result unchanged; on one thread it is about 8% faster and on every pass it uses 19–37% less memory. Only Effect's rules keep Bun's canary linter from replacing the lint pass, which is phase 2 on the owner's go (PR #20, G10, BER-2338).

🧭 **The core and the shell have a clearer line.** Decisions are plain pure functions with explicit inputs; Effect's built-ins do whatever waits, fails, races or needs cleanup; one writer per invariant, never one store; explicit commands only where the order is the promise. Astra, bob2 and the coordinator reached it with the owner on 11-22 (G11).

💥 **Next is step 4, the practices baseline, then step 5's fault experiments.** Step 4 records the practices and brings the listener in line with them, old step 6's cleanup included, so the faults (disk, clock, hung requests, a silent socket, crashes) run on code that will not move again (G9, G11, P6, P8).

🔌 **The listener grows into a hub on one action contract.** Each action is defined once and served as REST with OpenAPI, an MCP tool, Effect RPC and atoms, with the caller as an iron-control principal; it landed in PR #23 and PR #24 (G12).

🗂️ **Beside step 4, slice B builds a task hub that people and agents share.** Tasks carry A2A's states and who they wait on, since when; the UI is cut at the atoms, which run under the simulator while each renderer is checked in Storybook; Slack follows as the first adapter (G13, BER-2368).

🔬 **From here each step pairs a small slice with one testing method, with a bar and a time box.** TLA+ already found two design faults in the hub that the code and the random simulator missed, and the model now checks the code in CI; swarm testing comes next, then Hegel's shrinking. the owner, 11-22: "learning and building should go hand in hand".

---

## 🗺️ 1. What the request asks, and where it is

| In the request | Where it is in the plan |
| --- | --- |
| A plan | This document; the order of the work is section 5 |
| Experiments or spikes deemed important | F4–F6, F10–F19 run; S1, S3, S6, S7 and S9 measured, S2 and S8 partly; S4 and S5 still to measure |
| A Tiger Style specification, manifesto and principles | PRINCIPLES.md from PR #5; section 4.4 |
| Bring over the engineering principles | P2; folded into PRINCIPLES.md where they apply to one repository |
| Strengthen the linter, including oxlint's type-aware linting | P3, P9, D4, F8, F13; section 4.5 |
| Steps from today's working tool to the target | Section 5 |
| Tiger Style 101 and the sources at the bottom | Sections 7 and 8 |
| Show the whole process and the experiment | G5; section 4 and the phase diagram in section 5 |
| The decisions on the Slack SDK, Effect and the tooling | D1–D4 |

✋ **Step 2 of the tool, replies through the reply tool:** it waited for step 3, which is done; where it goes now is open with the owner.

✋ **A hypervisor-level simulator such as Antithesis, for now:** the Effect services are the seam chosen for an in-process tool. They cover less than a machine-level simulator and cannot snapshot the program; a machine snapshot comes back with the first agent-native workflow (F2, P1, G6).

✋ **A copyable plain-data store for the program's state:** dropped (G6).

✋ **An end point or a time budget for the experiment:** none is set (G8).

✋ **A general simulation framework or library:** the harness stays inside this repository until another project needs it.

✋ **Packaging with Nix:** a parallel session explores it; Effect's own flake is an input there, not a step here (F15).

✋ **A code-driven property pass:** properties drawn from the code beside the ones drawn from the rules; after step 6, in BER-2251 (G7).

✋ **UIs, with Effect extended into the UI, on vercel-labs/ui:** probably, after step 6, in BER-2252 (G7).

✋ **Branching long runs by process fork:** kept in BER-2217; it comes back with the first agent-native workflow (G6).

---

## 🧭 2. Decision log

| # | Decision | Who decided |
| --- | --- | --- |
| D1 | The thin Slack client stays. The SDK's Socket Mode client builds undici's WebSocket and runs on real timers, so it does not run over the simulator's fakes as they are; whether a ping/pong keepalive is needed beyond today's idle reconnect is decided in step 5 (F11, F12) | 🟢 USER; the reasons are the coordinator's |
| D2 | Effect stays at the program boundary: its services are the seams, and its rules enforce the error discipline inside Effect code; oxlint and tsconfig cover the plain-TypeScript core | 🟢 USER |
| D3 | Effect's services are the main seam and patched globals only a guard; the tripwire stays as the safety net. The argument that patching globals does not carry over to a database, many dependencies or several processes is the coordinator's | 🟢 USER; the reasons are the coordinator's |
| D4 | The toolchain is Effect's patched tsrs and oxlint from @effect/tsgo: no fork of tsrs, no Nix overlay of our own, no second checker beside tsrs | 🟢 USER |
| G1 | The experiment is Tiger Style and deterministic simulation testing of as much of the application as possible, not only of a pure core | 🟢 GIVEN |
| G2 | A Tiger Style specification, manifesto and principles exist, drawing on the engineering principles | 🟢 GIVEN |
| G3 | The linter gets stricter, oxlint's type-aware linting included | 🟢 GIVEN |
| G4 | The tool as it is works and is usable; the experimentation starts from it | 🟢 GIVEN |
| G5 | The plan shows the whole process: the steel thread, the first steps with the tooling and the approach, and the full architecture | 🟢 GIVEN |
| G6 | For now the program's state stays where Effect keeps it, and sequences are replayed. The copyable plain-data store is dropped (the owner, 11-20: "Drop the idea of the copyable pure plain data store."). Copying by process fork or a machine snapshot is revisited at the first agent-native workflow that needs a real database and a second process, or earlier if the search keeps replaying a long, costly prefix (Astra, 11-20) | 🟢 GIVEN, for now |
| G7 | UIs with Effect in the UI on vercel-labs/ui, probably, and a code-driven property pass come after this plan (the owner, 11-19: "The plan is the same. These are just steps for afterwards.") | 🟢 GIVEN |
| G8 | The experiment has no end point and no time budget; its scope is expected to grow so that it can test agent-native (the owner, 11-20: "I do not really want to bound this.") | 🟢 GIVEN |
| G9 | Step 5 includes disk failures in the middle of saving the state file, and a wall clock separate from elapsed time so clock jumps can be tested (the owner, 11-20) | 🟢 GIVEN |
| G10 | Bun is the likely runtime for what comes next (the owner, 11-21: "i'm fairly certian that's what i will use"), so a Bun experiment runs before the fault experiments. Pure Bun first; the owner expects differences in type checking, Effect's integration and linting, and is open to patching Bun to integrate Effect the way the Effect team did with tsrs | 🟢 GIVEN |
| P1 | The listener program reaches the world only through Effect services; production provides the Node platform layers, the simulator its own scheduler, clock and seed plus fakes at the tool level: the fetch function, the WebSocket constructor, stdio and the disk. Before the program starts, main.ts and config.ts read the arguments, configuration, tokens and lock file with Node, outside the simulation | 🟢 USER G1, F1, F3, F5, F7 |
| P2 | One PRINCIPLES.md for the repository: Tiger Style rules, the simulation rules, and the engineering principles that apply to a single repository, each with its enforcement and whether it holds today | 🟢 USER G2 |
| P3 | Lint is a ratchet: a rule turns on in the step that brings its hits to zero, and every rule is shown to catch a planted violation first; 15 of the 19 Effect rules turned on still have no planted case | 🟢 USER G3, F8 |
| P4 | The pure core stays: it holds the business-state transitions and the densest assertions, and Tiger Style keeps decisions in pure helpers. Since PR #10 the exhaustive pass runs the whole program, not only the core | 🟢 USER G1, P1 |
| P5 | Every simulator decision comes from one choice stream, where 0 is the simplest choice, so fast-check can shrink the run itself; today it shrinks a seed and up to 60 choices, not yet the actions and faults | 🟢 USER F6 |
| P6 | In-flight requests and deliveries get deadlines, as a new rule in RULES.md; the owner approves the rule text | 🟢 USER F9, S4 |
| P7 | Repeated states are not skipped for now (the owner, 11-18: "let's not go that way now"); the measured view would save 5.9% before hashing, and its soundness is not proven (S8) | 🟢 USER |
| P8 | Incoming JSON (socket frames, Slack's HTTP responses, MCP requests, the state file) is decoded with Effect Schema at the boundary in step 4c; for each boundary the step states whether bad input is rejected, logged or fatal, and keeps old state files readable | 🟢 USER F17, D2 |
| P9 | Tiger Style work goes where it is cheapest. Code a step adds or changes gets assertions from the start; step 4c's Schema checks remove most casts; strict-boolean-expressions and no-unnecessary-condition (11 hits) turned on at the first point they fit, right after 3d (the owner, 11-20; PR #19); long functions, the cast ban, density in untouched code and lint on the test files come in step 4, before the fault experiments (G11) | 🟢 USER F8, P3 |
| P10 | The exhaustive alphabet grows before the fault experiments (step 3d): our own side's answer, done and an API failure become actions, each shown to catch a bug PR #13's runs missed | 🟢 USER S8, G1 |
| G11 | The listener first gets a practices baseline as step 4, from the core and shell discussion with Astra and bob2; the fault experiments become step 5, run shrinking step 6, and old step 6's cleanup folds into step 4 (the owner, 11-22: "we can split 3f further / even make it step 4 with substeps and bump the current step 4->5 5->6"). The practices are a draft proven in the listener; agent-native adopts them after a second proof of concept | 🟢 GIVEN |
| G12 | The listener grows into a hub on one action contract: each action is defined once and served as REST with OpenAPI, an MCP tool, Effect RPC and atoms; the caller is an iron-control principal and permissions come from a Policy service, so it ties into iron-proxy and Porta later (the owner, 11-22: "A can go as that is the action contract and not the feature def no?"; "if rpc is simple then let's also have it") | 🟢 GIVEN |
| G13 | Slice B is a task hub that people and agents share, in place of receipts: A2A's task states, who a task waits on and since when, claim with a lease, cancel and amend, every event with its actor and replayable from a cursor. Vercel Board gives the claim, lease, result and actor, eggp's Slack MCP spec the single writer and post-once delivery; messaging apps are adapters around it, Slack first. The UI is cut at the atoms: view state is Effect atoms run under the simulator, and each renderer (web first, then mobile, desktop and extensions) is checked in Storybook against fixed atom states (the owner, 11-22: "B can go"; "split the ui on effect atom and use the simulator on the atoms effect while we test the ui part on storybook") | 🟢 GIVEN |

---

## 🔬 3. What the research and the spikes showed

F3, F5 and F10 drive the simulation design: Effect's runtime is replaceable, its real HTTP client and socket run deterministically over fakes, and the seed decides where Effect actually interleaves. F15 drives the tooling.

### 3.1 All facts, with source and consequence

| # | Fact | Source | What follows from it |
| --- | --- | --- | --- |
| F1 | TigerBeetle and FoundationDB run their real code in one process and swap clock, network and disk for controllable, fault-injecting versions | [TigerBeetle VOPR](https://docs.tigerbeetle.com/concepts/safety/), [FoundationDB testing](https://apple.github.io/foundationdb/testing.html) | ➡️ The simulator runs the program; only the world is fake (P1) |
| F2 | Antithesis makes the whole machine deterministic and runs unchanged containers, with simulated network and storage | [Antithesis: deterministic hypervisor](https://antithesis.com/blog/deterministic_hypervisor/) | ➡️ Our adaptation fakes at the tool level through Effect services: a narrower seam that covers less than a machine and cannot snapshot it (P1) |
| F3 | Effect 4.1.4's Scheduler, Clock and Random are replaceable context references; their defaults use setImmediate, Date.now with setTimeout, and Math.random | effect/src/Scheduler.ts:82, internal/effect.ts ClockImpl, Random.ts | ➡️ Effect's runtime can be owned by the simulator, for code that uses these services (P1) |
| F4 | Spike 1: two fibers with timeouts, jittered retries and a race under a simulator scheduler and clock finished synchronously; 500 of 500 seeds replayed identically, 0 real timers | scratchpad/dst/spike.ts | ➡️ Interleaving is decided at I/O and time boundaries, which the simulator controls |
| F5 | Spike 2: Effect's FetchHttpClient and Socket.makeWebSocket ran over a fake fetch and a fake WebSocket constructor with hangs, network errors and crash-restarts; 300 of 300 seeds identical, 0.34 ms per run, 0 real timers | scratchpad/dst/spike2.ts | ➡️ The fake Slack can sit under the real clients (P1) |
| F6 | Spike 3: fast-check shrank a whole run's choice tape to 4 values and an 11-event run; a choice that consumes an extra value shifts every later one, which limits shrinking | scratchpad/dst/spike3.ts | ➡️ One choice stream, 0 the simplest, kept aligned (P5); the listener's own shrinking is still to be shown (S5) |
| F7 | @effect/platform-node 4.1.4 is published for Effect 4.1.4; the listener uses @effect/platform-node-shared 4.1.4 | npm view @effect/platform-node; package.json | ➡️ Production layers exist (P1) |
| F8 | oxlint 1.90 runs type-aware rules through tsrs-lint, bans globals, properties and imports per file, and runs JS plugins; it has no no-restricted-syntax. An assertion-density JS plugin found 70 functions below two assertions on 11-17; it counts assert calls in the text, so it is a survey aid | lint survey on a scratch copy; PR #5 evidence | ➡️ The ratchet in section 4.5 (P3) |
| F9 | The phase 1 simulator drove only the core through its own interpreter; the shell never ran under it. A fetch or delivery that never answers stalls delivery for good | review of 3626fda; scratchpad/dst/hang.ts | ➡️ PR #10 removed the interpreter; the missing deadlines remain (step 5c, P6) |
| F10 | Effect resumes a waiting fiber directly and asks the scheduler only when a fiber uses up its turn (2048 operations by default) or a fork starts; a crash cannot stop a fiber, only drop what would wake it | [PR #6](https://github.com/mimukodik/slack-listener/pull/6), DECISIONS.md | ➡️ The seed picks the order of ready tasks and timers due together and a per-turn budget; fakes answer through timers of the process that asked (step 3) |
| F11 | @slack/socket-mode 3.2 keeps its connection alive with setInterval and setTimeout, reads Date.now and constructs undici's WebSocket, with undici's ping/pong channels; @slack/web-api 8.4 takes an injected fetch | SlackWebSocket.js:38, :123, :307–337 and WebClient.js:146 in the published packages | ➡️ The SDK does not run over the simulator's fakes unchanged (D1) |
| F12 | The listener has no ping/pong keepalive, but it reconnects after 5 minutes without a frame from Slack, checked on a 30-second tick, and has done so since phase 1 | src/core.ts:26, src/core.ts:927; a pure-core probe, 11-20 | ➡️ Step 5d measures how fast a silent socket is noticed, then decides on ping/pong (D1) |
| F13 | On 11-17, before the fixes: oxlint's type-aware rules include only-throw-error, prefer-promise-reject-errors, use-unknown-in-catch-callback-variable and no-useless-catch (0 hits each on src), require-await (1), promise-function-async (8), strict-boolean-expressions (6); tsconfig's noUncheckedIndexedAccess gave 9 errors, exactOptionalPropertyTypes 2 | probe of each rule on a planted file and on src, 11-17 | ➡️ The plain-TypeScript error rules in the ratchet (D2, section 4.5) |
| F14 | Effect's own diagnostics cover what plain lint cannot: floatingEffect, missingEffectError, missingEffectContext, globalErrorInEffectFailure, unknownInEffectCatch, tryCatchInEffectGen | [@effect/language-service](https://github.com/Effect-TS/language-service) README | ➡️ The error discipline inside Effect code comes from Effect's rules (D2) |
| F15 | @effect/tsgo 0.70 ships Effect-patched builds of tsrs 0.25 and oxlint 1.91–1.94: 33 small patches on a pinned tsrs plus 39 crates of rules and tooling, run with effect-tsgo tsrs and effect-tsgo --tsrs-lint oxlint without changing node_modules; both flags are experimental | [Effect-TS/tsgo](https://github.com/Effect-TS/tsgo) README and _patches/tsrs | ➡️ No fork and no overlay of our own (D4); step 1b |
| F16 | A suspended Effect program cannot be copied from JavaScript, but the whole process can: Fable's native fork resumed a copy on macOS and Linux. One fork, child run and wait cost 4–14 ms against a 0.5–2.9 ms replay of today's short sequences | DECISIONS.md, 2026-11-18 (BER-2207), BER-2217, scratchpad/fable/forktest2.ts | ➡️ Replay for now; the crossover for long sequences is not measured (BER-2217, G6) |
| F17 | src has 29 type assertions outside the tests (an earlier count of 68 included the test files by mistake); JSON from Slack's socket and HTTP responses, the MCP session and the state file is cast to its type without a check, and src/config.ts checks its fields by hand | consistent-type-assertions on main f57532d, recounted 11-20; src/shell.ts:96, :167, src/mcp.ts:137, src/slack-api.ts:86 | ➡️ A malformed input fails somewhere past the boundary instead of at it (P8) |
| F18 | The simulator's tripwire throws only on real timers and process.nextTick. Lint bans Date.now and Math.random in the core's and the program's files, but a bare new Date() passes both, and config.ts, main.ts and the dependencies are outside the bans | src/sim/host.ts:80, .oxlintrc.json overrides; planted probes, 11-20 | ➡️ Step 5b's clock work extends the tripwire to new Date() and Math.random (K2) |
| F19 | The simulator keeps one time value for the wall clock and for elapsed time | src/sim/runtime.ts:144–157 | ➡️ They are separated before clock jumps are tested (step 5b, G9) |

---

## 🧪 4. The experiment, phase by phase

The steel thread made the tool work and put it in use; the first steps tried the tooling and the approach on that simple setup; the full architecture is what is tested now.

🧵 Phase 1 · steel thread pure core, shell, core simulator, exhaustive pass, live on Slack ✅ PR #1–#4 → 🦶 Phase 2 · feet wet principles, stricter lint, simulation runtime ✅ PR #5–#6 → 🏗️ Phase 3 · full architecture toolchain, shell as Effect, whole program simulated, faults, shrinking, cleanup ▶️ step 3d next

### 4.1 🧵 Phase 1 · the steel thread

| PR | What it established |
| --- | --- |
| [#1](https://github.com/mimukodik/slack-listener/pull/1) | The tool: a pure core step(state, event, now), a shell that runs its effects, the rules in RULES.md, and a seeded simulator with fast-check driving the core against a fake Slack with sleep, failures and forged framing |
| [#2](https://github.com/mimukodik/slack-listener/pull/2) | Own-side thread parents quoted (R17), and the review's other gaps closed: checks that could not fail were made able to |
| [#3](https://github.com/mimukodik/slack-listener/pull/3) | The fake Slack compared with recorded real events, and a bounded exhaustive pass: every sequence of up to 7 actions, 87,796 sequences, no violation |
| [#4](https://github.com/mimukodik/slack-listener/pull/4) | A lean public repository: placeholder ids only, docs in English and Hungarian |

🟢 **It works and is in use:** a post, a reply and an edit each reached the session once, 3 to 4 s after posting, and bob-check runs on it.

🐛 **The simulator paid off early:** four real core bugs were found before any live run, each kept as a scenario test.

🚧 **Its limit sets phase 3:** the simulator drives only the core through an interpreter of its own, so the shell, where reconnects, catch-up and the state file live, is never simulated (F9).

### 4.2 🦶 Phase 2 · getting our feet wet

| Step | PR | What it established |
| --- | --- | --- |
| 0 | [#5](https://github.com/mimukodik/slack-listener/pull/5) | PRINCIPLES.md: a manifesto and 19 principles, each with how it is enforced and whether it holds today; type-aware lint and the determinism bans on the core and simulator files |
| 1 | [#6](https://github.com/mimukodik/slack-listener/pull/6) | The simulation runtime: a seeded scheduler, clock and Random, crash without cleanup, and a tripwire on real timers; 200 seeds replay identically at about 0.55 ms per run, and 17 planted bugs each fail a test |

💡 **The scheduler is asked less often than expected:** Effect resumes a waiting fiber directly, so the seed orders the tasks and timers due together and cuts a busy fiber's turn at a seeded budget (F10).

💡 **A crash cannot stop a fiber:** it can only drop what would wake it, so fakes answer through timers of the process that asked (F10, K6).

💡 **The spike's turn budget was wrong:** Effect's default is 2048 operations, not 64; with every turn-budget choice 0, the runtime's reference program runs exactly Effect's own schedule (PR #6).

💡 **The tooling direction is set:** the thin Slack client, Effect, globals as a guard, and Effect's patched tsrs and oxlint for the lint (D1–D4).

### 4.3 🏗️ Phase 3 · the full architecture

Production and the simulator start the same Effect listener program and provide different layers under it. Before it starts, main.ts and config.ts read the arguments, configuration, tokens and lock file with Node, outside the simulation.

🧠 Pure core step(state, event, now) ⚙️ Program Effect: runs the core's effects Clock · Random · Scheduler · HttpClient · Socket · Stdio · FileSystem 🟦 Production layers @effect/platform-node-shared, real Slack, the session over stdio, the state file 🟪 Simulator layers seeded scheduler and clock, fake fetch and WebSocket over the fake Slack, fake session, in-memory disk, tripwire on real timers

Lint is one pass on Effect's patched tsrs: oxlint's rules, the type check and Effect's rules from tsconfig.json, with no second type checker (D4, F15, PR #8):

```bash
effect-tsgo --tsrs-lint oxlint --type-aware --type-check --tsconfig tsconfig.json src  # one pass on the Effect-patched tsrs
```

What phase 3 has landed so far, R18's reactions included; R18's final version still waits for its live check (BER-2242):

| Step | PR | What it established |
| --- | --- | --- |
| 1b | [#7](https://github.com/mimukodik/slack-listener/pull/7) | Effect's rules in the type check, the plain-TypeScript error rules and the two tsconfig flags; their 21 hits fixed |
| 1b | [#8](https://github.com/mimukodik/slack-listener/pull/8) | Lint in one pass on Effect's patched tsrs, with no second type checker |
| 2 | [#9](https://github.com/mimukodik/slack-listener/pull/9) | The shell as one Effect program over services; main.ts provides the Node layers |
| 3 | [#10](https://github.com/mimukodik/slack-listener/pull/10) | The simulator and the exhaustive pass run the program main.ts runs; their own interpreters are deleted |
| 3b | [#11](https://github.com/mimukodik/slack-listener/pull/11) | The exhaustive pass fast again: a synchronous drain, valid sequences only, split across cores; passing runs give the same results |
| 3c | [#12](https://github.com/mimukodik/slack-listener/pull/12) | The 2000-seed pass on the worker pool, every seed's result unchanged |
| R18 | [#13](https://github.com/mimukodik/slack-listener/pull/13) | 👀 on a message that reached the session (BER-2242) |
| R18 | [#14](https://github.com/mimukodik/slack-listener/pull/14) | The session's done tool, for a message that needs no reply |
| R18 | [#15](https://github.com/mimukodik/slack-listener/pull/15) | A muted check mark replaces 👀 once a message is answered or marked done; checked live on 2026-11-21 |
| 3c | [#16](https://github.com/mimukodik/slack-listener/pull/16) | A run's fixed cost cut by 15–20%, every seed's result unchanged; skipping repeated states measured and put off |
| record | [#17](https://github.com/mimukodik/slack-listener/pull/17) | PRINCIPLES.md and DECISIONS.md corrected after Astra's review: the tripwire, the idle reconnect, the SDK's WebSocket, the holds-today column |
| 3d | [#18](https://github.com/mimukodik/slack-listener/pull/18) | The exhaustive alphabet gains our own answer, done and a failing call; six of eight R18 bugs it missed now fail it (BER-2285) |
| P9 | [#19](https://github.com/mimukodik/slack-listener/pull/19) | strict-boolean-expressions and no-unnecessary-condition on; eleven hits fixed, every seed's result unchanged |
| 3e | [#20](https://github.com/mimukodik/slack-listener/pull/20) | The repository on Bun 1.4.5: bun.lock, bun test, bun fmt, the drain through bun:jsc, Effect's Bun layers; every result unchanged (BER-2338) |

### 4.4 📜 The principles that do not hold yet

The full set, with the manifesto, is PRINCIPLES.md in PR #5. These seven are what the steps change.

| Principle | Gap today | Step that closes it |
| --- | --- | --- |
| `world-through-services` | 🟡 The listener program reaches the world only through Effect services (PR #9); main.ts and config.ts use Node before it starts, and a bare new Date() passes lint and the tripwire (F18) | 2, 5 |
| `one-seed-one-run` | 🟡 Partly: a seed replays the whole program identically in the checks so far, but the disk contents are not compared (S2) | 3, 6 |
| `simulator-runs-the-program` | 🟢 Closed: the simulator and the exhaustive pass run the listener program main.ts runs; their own interpreters are deleted (PR #10) | 3 |
| `limit-everything` | No deadline on in-flight HTTP requests or session writes; no ping/pong (the idle reconnect exists, F12); the thread-starter cache is unbounded, and the queues, waiters and caches are still to be counted | 4h, 5 |
| `shrink-the-run` | fast-check shrinks a seed and up to 60 choices, not the actions and faults | 6, started alongside 5 |
| `assert-the-invariants`, `simple-control-flow` | Assertions in the core and the runtime, not at density; nine functions over 70 lines | 4e, 4f |
| `guardrails-are-proven` | 15 of the 19 Effect rules turned on have no planted case | 4g |

### 4.5 🧹 The lint ratchet

| Rule | Hits now | On from |
| --- | --- | --- |
| Type-aware promise, switch and unsafe rules; no any, no non-null; nesting, parameters, reassignment | 0 | 🟢 PR #5 |
| Determinism bans on the core, format, settle, slack and simulator files | 0 | 🟢 PR #5 |
| Effect's rules through the patched tsrs: floatingEffect, missingEffectError, globalErrorInEffectFailure and the rest (F14) | 0 | 🟢 PR #7 |
| only-throw-error, prefer-promise-reject-errors, use-unknown-in-catch-callback-variable, no-useless-catch | 0 | 🟢 PR #7 |
| require-await, promise-function-async | 0 | 🟢 PR #7 |
| tsconfig noUncheckedIndexedAccess, exactOptionalPropertyTypes | 0 | 🟢 PR #7 |
| The determinism bans on the program's files | 0 | 🟢 PR #9 |
| `strict-boolean-expressions`, `no-unnecessary-condition` | 0 | 🟢 PR #19 |
| `max-lines-per-function` 70 | 9 | 4e |
| `tiger/assert-density` (JS plugin, two per function over 20 lines) | 68 | 4f; code step 5 adds meets it from the start (P9) |
| No recursion (JS plugin) | 4 functions: attempt in shell.ts, page in slack-api.ts, collect and strip in the conformance fixture | 4b removes the retry's; the rest in 4e |
| `consistent-type-assertions`: no `as` casts | 29 | 4d, after 4c decodes incoming JSON |
| The rules on the test files, with the nesting limit relaxed for describe and it | 29, 22 of them nesting | 4g |

---

## 🛣️ 5. Order of the work

✅ 📜 0. Principles and lint ✅ ⏱️ 1. Simulation runtime ✅ 🧰 1b. Toolchain ✅ ⚙️ 2. Shell as an Effect program ✅ 🌍 3. Whole program simulated ✅ ⚡ 3b. Fast exhaustive pass ✅ 📏 3c. Three optimisations ✅ 🔤 3d. Larger alphabet ✅ 🥟 3e. Bun experiment ▶️ 🧭 4a–4h. Practices baseline 💥 5a–5e. Fault experiments 🔍 6. Run shrinking, beside 5 ✅ 🔌 A. Action contract and RPC ▶️ 🗂️ B1–B3. Task hub 💬 C. Slack adapter

| Step | What lands | Kind | Done when |
| --- | --- | --- | --- |
| 0 | PRINCIPLES.md and the stricter lint | structure | 🟢 DONE: PR #5 merged after review and green CI |
| 1 | src/sim/runtime: the seeded scheduler, clock and Random, the choice stream and the tripwire, from the spikes | structure | 🟢 DONE: PR #6; a self-test replays seeds identically with 0 real timers (S2), 17 planted bugs caught |
| 1b | @effect/tsgo 0.70 with oxlint 1.94 and tsrs 0.25; lint is one pass of effect-tsgo --tsrs-lint oxlint --type-check; nineteen Effect error rules, six oxlint error rules and the two tsconfig flags on, their 21 hits fixed | structure | 🟢 DONE: PR #7, corrected to one pass in PR #8; twelve planted violations each fail lint (S7) |
| 2 | The shell rewritten as an Effect program over HttpClient, Socket, Stdio, FileSystem and Clock; main.ts provides @effect/platform-node-shared, which avoids undici and a redis peer; the determinism bans extend to it | structure, with recorded differences | 🟢 DONE: PR #9 after two review rounds; eleven planted violations fail lint; on real Slack on 2026-11-18 a post, a reply and an edit each reached the session once (G4). DECISIONS.md lists its few behaviour differences, such as the 10 s handshake limit |
| 3 | The fake Slack moves under fetch and the WebSocket constructor; a fake session reads stdio; the checkers observe what the session receives; the simulator's and the exhaustive pass's own interpreters are deleted | structure | 🟢 DONE: PR #10 (BER-2193, by Pixi); every existing rule check passes on the whole program; three planted shell bugs caught in 86.5–99.95% of seeds (S3); 5.6x slower per run (S1) |
| 3b | The exhaustive pass fast again: promise callbacks drained synchronously instead of one real setImmediate per step, only valid sequences run, the pass split across up to 8 worker threads | structure | 🟢 DONE: PR #11 (BER-2207); passing runs give the same sequences and results; a failing run stops at its first failure (S1) |
| 3c | Three optimisations, each measured before the next: the 2000-seed pass on the worker pool, skipping repeated states, the fixed cost of a run | structure | 🟢 DONE: PR #12 and PR #16 (BER-2216); every seed's result unchanged; skipping repeated states put off (S1, S8, S9, P7) |
| 3d | The exhaustive alphabet grows: our own side's answer, done and an API failure become actions | structure | 🟢 DONE: PR #18 (BER-2285); six of eight R18 mutants that passed main's depth 7 fail at depth 2–4, the other two are caught by the sampled pass; depth 7: 680,613 sequences, 0 violations (S1) |
| 3e | The simulator and the listener on Bun: first pure Bun, recording every difference from Node in type checking, Effect's integration and linting; patching Bun to integrate Effect, as the Effect team patched tsrs, only from those differences and on the owner's go | structure | 🟢 DONE: PR #20 (BER-2338); the 2000-seed hash equals Node's and depth 7 is unchanged; on one thread Bun is about 8% faster, with 8 worker threads in one process slower on the 2000 seeds; 19–37% less memory; live on real Slack on 2026-11-21, a post, a reply and an edit each claimed once (G10) |
| 4a | Record the practices in PRINCIPLES.md: decisions as plain pure functions with explicit inputs; Effect's built-ins for whatever waits, fails, races or needs cleanup; one writer per invariant, never one store; explicit commands only where the order is the promise; decode once at the boundary; bound all admitted work; each guarantee proven by a planted violation | structure | 🟢 DONE: PR #21 merged after review and green CI; seven practices, each with its failure, its check and whether the listener holds it, every gap named by the substep that closes it (G11, BER-2354) |
| 4b | Retries into Effect: the core's reconnect backoff and the shell's recursive reaction retry become Schedules with the same delays and caps | structure | 🟢 DONE: PR #22 merged after review and green CI; reconnect, catch-up, delivery and reaction retries run on Schedule with the same delays on the virtual clock (1 s doubling to 60 s; 0/1/3/7 s; 0/1/3 s); five reviewer mutants caught; depth 7 coverage identical to main, the 2000-seed hash shifted by ordering only (BER-2354) |
| 4c | Malformed input: Schema decoding of socket frames, Slack's HTTP responses, MCP requests and the state file | behaviour | 🟢 DONE: PR #29 merged after review and green CI; rules R19–R22, with the owner's R21 sentence on a thread parent that does not decode; the simulator now sends malformed input, and the reviews caught a lost-replies bug and a false alarm in the acknowledged-once check, both fixed (BER-2354) |
| 4c+ | The listener's TLA+ models in spec/listener: the reactions model with a replay of its counterexample, the listener model as a design check; the fix for a given-up ✅ that still removes 👀; the rule sentences the model showed missing | behaviour | 🟢 DONE: PR #30 merged after review and green CI; Listener.tla and Marks.tla in spec/listener, 34 TLC configurations as expected; a given-up ✅ now keeps 👀, replayed from TLC's counterexample; the owner's rule sentences in R4, R7, R18 and R21 (BER-2354) |
| 4d | The as-cast ban, once 4c decodes incoming JSON | structure | consistent-type-assertions reports 0 and fails a planted cast; after swarm testing |
| 4e | Functions to 70 lines and no recursion, control flow in the parent | structure | The two rules report 0; every seed's result unchanged |
| 4f | Assertions to density across the code | structure | tiger/assert-density reports 0; a planted corrupt state stops the process (P9) |
| 4g | The remaining rules on, the test files included with nesting relaxed for describe and it; a planted case for each Effect rule that has none | structure | Each rule fails a planted violation (guardrails-are-proven) |
| 4h | Bound the event queue that feeds the core and define what happens when it is full, as rule text the owner approves | behaviour | A stalled-session run fails before and passes after; the rule is in RULES.md |
| 5a | Disk: writes and renames that fail, a crash between the write and the rename, a corrupt state file and an old-format one | behaviour | Each fault has a stated expected outcome; a mutant fails it and the code passes it (G9) |
| 5b | Clock: the wall clock separate from elapsed time, the wall clock jumping forward and back; the tripwire also refuses a bare new Date() and Math.random | structure, then behaviour | A planted clock bug fails a jump run; a planted new Date() trips the simulator (F18, F19) |
| 5c | Hung requests: deadlines on HTTP requests and session writes, as rule text the owner approves | behaviour | A never-answers run fails before the deadline and passes after (S4, P6) |
| 5d | Silent socket: how fast today's idle reconnect notices a dead connection; ping/pong only if it helps | behaviour | The time to notice is measured, and the ping/pong decision rests on it (S4, F12) |
| 5e | Crashes at the critical points: just before a save, before an event reaches the session, before a done is confirmed | behaviour | Every rule holds at each crash point (P9) |
| 6 | Actions and faults on the one choice stream, kept aligned; started alongside step 5, so the first planted failure already shrinks | structure | A planted listener bug shrinks to a short run that replays on its own (S5) |

### 🗂️ The hub, beside step 4

| Step | What lands | Kind | Done when |
| --- | --- | --- | --- |
| A | The action contract: each action defined once, served as REST with OpenAPI, an MCP tool and atoms; the caller an iron-control principal, permissions from a Policy service | structure | 🟢 DONE: PR #23 (BER-2357) merged after review and green CI; the surfaces agree on results, errors, refusals and the store, plain and simulated (G12) |
| A2 | Effect RPC as a fourth surface | structure | 🟢 DONE: PR #24 (BER-2363); 98 lines of code, no Effect patch, six planted bugs caught |
| E | Three Effect 4.1.4 liveness bugs patched, so the seed picks preemption points again | structure | 🟢 DONE: PR #28 merged after review and green CI; 20,000 agreement runs on the seeded budget: patched 0 failed, unpatched 12; each bug a regression test; upstreaming waits for the owner |
| B1 | The task store and its actions: A2A states, claim with a lease, request input and answer, cancel, amend, complete, events from a cursor with the actor; SQLite with one writer | behaviour | 🟢 DONE: PR #25 and PR #26 (BER-2368) merged after review and green CI; rules T1–T7 in RULES.md, 18 planted bugs caught; a TLA+ model found that oldest-first claims starve a lapsed task and that the clock was read outside the write transaction, both fixed (G13) |
| B1c | The round trip between the TLA+ model and the code: TLC's paths replayed through the real actions in CI, and the hub simulator's traces checked against the model with TLC | structure | 🟢 DONE: PR #27; 1,367 paths, 8.6 s in CI, nine bug counterexamples fail at their recorded step; 100 correct traces accepted, a stale-holder trace rejected |
| B2 | Two sessions as separate programs over a link that fails; the waiting action with a filter; crashes and a reply lost after commit; escalation of unseen input requests | behaviour | Every rule holds across the two programs; an input request its owner hasn't seen within N minutes escalates |
| B3 | The UI cut at the atoms: view state (my inbox, a task, the answer form) as Effect atoms under the simulator; a web renderer on Vercel's UI SDK (vercel-labs/ui) with Tailwind and a Tailwind lint, checked in Storybook against fixed atom states (the owner, 11-22: "we will be building our ui on Vercel ui sdk … And tailwind and tailwind lint") | behaviour | The view rules hold under the simulator, and every story renders from atom state alone; mobile, desktop and extensions later add renderers only (G13) |
| C | Slack as the first adapter: the hub holds the connection; the reactions 👀 🛠 ✅ ❌ show task state; input requests become buttons | behaviour | Delivery to each session confirmed; every interaction acked within 3 s; a double click records once |

### 🔬 The methods, one per step

| Order | Method | Paired with | Bar | Time box | State |
| --- | --- | --- | --- | --- | --- |
| 1 | TLA+ and TLC: safety and design questions | B1, the task store | Every planted bug caught with a short trace; each design choice checked, not argued | 1 h | 🟢 DONE: 11 planted bugs caught in under 3 s each; found that oldest-first claims starve a lapsed task and that the clock was read outside the write transaction |
| 1b | TLA+ on the listener, from its rules alone | Step 4c+ | Every planted bug caught with a short trace; each rule checked or named as not modelled | 75 min | 🟢 DONE: 13 planted bugs caught; a given-up ✅ left a message with no mark, and five cases the rules left open; in the repo with PR #30 |
| 2 | The round trip between model and code | B1c | A correct trace validates, a stale-holder trace is rejected, and a TLC counterexample fails against its bug in the real code | Half a day | 🟢 DONE: PR #27; the replay stays in CI, trace validation stays a local tool |
| 3 | Swarm testing: each run switches some actions and faults off | The listener's and the hub's simulators | A predeclared mutant's kill curve improves at equal runtime, with baseline coverage kept | 1 h | ⏸️ MEASURED, DROPPED, NOT YET LANDED: across 19 predeclared planted bugs, swarm caught fewer at equal runtime and lowered most coverage counters, so its code is removed; the record waits for review and a PR on branch the swarm experiment branch |
| 4 | Hegel as the shrinker on the choice stream, with readable failure reports | Step 6 | The same planted failure shrinks to a run as short as fast-check's at its best, or about as short with a clearly more readable report (the owner, 11-22: readable errors count); the TypeScript client @hegeldev/hegel runs in-process on Bun, with stateful runs | 2 h | Waiting on 3 landing |
| 5 | BUGGIFY limit knobs, an Effect service that is a no-op in production | Steps 5b to 5e | Each knob reaches its boundary and exposes a named failure | 1 h per knob | Waiting on 4 |
| 6 | TLA+ liveness with two calls in flight, and arrivals | B2 | The clock order is proven with concurrent callers; starvation is checked with tasks arriving | 2 h | Waiting on 5 |
| 7 | Bombadil on the rendered page | B3 | It catches a planted renderer bug that the atom-level simulator cannot see | 2 h | Waiting on 6 |
| 8 | One Stryker mutation report on the pure files | Once, after B1 | Every survivor classified, and each missing assertion named | 1 h | Waiting on 3 |

💡 **Ideas held back, each with the evidence that brings it in.<br />**🧬 **A model derived from the code with tla-ts:** if the round trip shows the code and Tasks.tla drifting apart.<br />📤 **defineOperation for outbound calls:** at slice C, the hub's first outbound call, with commit and reply as correlated steps.<br />🧮 **A transition DSL or compiler:** only if the round trip shows a further representation is needed.<br />🗺️ **Hashing explored states:** only with evidence that merged states have the same futures.<br />🔀 **A bounded schedule search over the choice stream:** after step 6; if it cannot find the three Effect bugs on unpatched Effect, that is the case for a symbolic Effect interpreter (the owner, 11-22: "If deemed high value I'm not against").

### 📏 Measurements

| # | What we measure | Why | Result | State |
| --- | --- | --- | --- | --- |
| S1 | Time of the passes: whole-program runs, 2,000 seeds of 120 actions, and the exhaustive pass at depth 7 | How the cost moves as the alphabet and the faults grow (G8: recorded, no budget) | PR #10: 41 ms per run against 7.4 ms for the core alone, 5.6x. PR #11: depth 7 in 45–73 s in CI. After PR #16, locally on 8 workers: depth 7 in 14.8–15.9 s and 2,000 seeds in 5.9–6.0 s; Astra's rerun on 11-20: 14.3 s and 5.5 s. After PR #18's larger alphabet: depth 7 is 680,613 sequences, 96 s locally on 8 workers and 260 s in CI on 4 (whole CI job 5.5 min); depth 6 is 88,547 sequences in 14 s locally | 🟢 VERIFIED |
| S2 | Replay of the same seeds twice, traces compared, and real timers counted | `one-seed-one-run` for the program, not only the core | The runtime: 200 seeds, half with a crash, identical, 0 real timers, about 0.55 ms per run (PR #6). The whole program: one seed of 30 actions replays identically, and three seeds match traced and untraced (PR #10, PR #16); the disk contents are not compared yet | 🟡 PARTLY |
| S3 | Share of seeds that catch three planted shell bugs: a parent cached from another thread, a wrong socket generation, a lost page of history | Step 3 proves the shell is really under test | 99.95%, 99.85% and 86.5% of 2,000 seeds (PR #10) | 🟢 VERIFIED |
| S4 | Hung HTTP and session-write runs before and after the deadlines; the time today's idle reconnect takes to notice a silent socket | P6, F12 | – | 🔴 TO MEASURE |
| S5 | Events left after shrinking a planted listener bug, and whether the shrunk run replays on its own | P5 | – | 🔴 TO MEASURE |
| S6 | Hits of each ratchet rule on src, without the test files | P3, P9 | 11-20: 29 casts, 11 boolean and condition hits, 9 long functions, 68 below assertion density (section 4.5); the boolean and condition hits are 0 since PR #19 | 🟢 VERIFIED |
| S7 | Effect-rule hits on today's code, a planted floating Effect and plain Error failure caught, and lint time against today's | D4: whether the patched toolchain fits | All 149 rules: 312 hits, none from the correctness rules; the 19 turned on: 0. Twelve planted violations caught: four Effect rules, six oxlint rules and the two tsconfig flags (PR #7); 15 of the 19 Effect rules have no planted case yet. One warm checker pass: 0.22–0.24 s against 0.28–0.29 s for PR #7's two passes (PR #8) | 🟢 VERIFIED |
| S8 | Share of depth-7 prefixes that reach a state another prefix already reached, by a fingerprint of the exposed state | Whether skipping repeated states pays (P7) | With every exposed field, none; a view without ids and times merges 2.1%, 6.4% and 11.9% at lengths 5, 6 and 7, which would save 5.9% of depth 7 before hashing (BER-2216). The view is not proven sound: it leaves out fibers, timer callbacks and the ready work | 🟡 PARTLY |
| S9 | Where a short run's time goes, by a CPU profile of 30,000 empty and 10,000 seven-action runs | Whether the simulator's fixed cost per run can be cut | Mostly the program itself: Effect's fiber loop, garbage collection and the promise drain; two simulator cuts saved 15–20% with every seed's result unchanged (PR #16). This does not show that nothing more can be saved | 🟢 VERIFIED |

---

## ⚠️ 6. Risks

| # | Topic | Proposal |
| --- | --- | --- |
| K1 | The fake Slack drifts from real Slack, and a green simulator proves less | Record each new event kind with the existing recorder, which takes Socket Mode events only; Slack's HTTP responses need a recorder and conformance tests of their own, before the faults that depend on them |
| K2 | Code outside Effect, a library or a stray await, reaches a real timer, clock or promise and breaks replay | The tripwire throws on real timers and process.nextTick, and lint bans Date.now and Math.random in the core and the program; a bare new Date() passes both until step 5b extends the tripwire (F18) |
| K3 | A race inside synchronous code is reordered only at Effect operation boundaries | Since PR #6 the seed cuts a busy fiber's turn short at a chosen operation, down to one; plain JavaScript between operations stays atomic, as in FoundationDB |
| K4 | A change to the shell breaks the live tool | Step 2 was checked live before bob-check restarted on it, and its few behaviour differences are recorded in DECISIONS.md; every later change to live behaviour gets its own live check, as R18's final version did on 2026-11-21 (BER-2242) |
| K5 | A choice that consumes extra values shifts later choices and weakens shrinking (F6) | S5 measures it; per-source choice streams if it stays weak, with their replay encoding stated |
| K6 | A crashed process runs again if something outside the runtime resumes it (F10) | Fakes answer through timers of the process that asked, and a task of a crashed process stops the run; code a dead process runs before it next schedules is not caught, a known limit of the simulator |
| K7 | @effect/tsgo trails tsrs and oxlint releases (it supports tsrs 0.25 and oxlint 1.91–1.94), so our upgrades wait for theirs | Pin both to its supported versions; if it falls behind for long, oxlint's own rules and tsconfig still hold the plain-TypeScript discipline, with less Effect-specific coverage |
| K8 | Step 3d's actions and step 5's faults make the exhaustive pass slow, because every sequence is replayed from a fresh program (F16, G6) | Record depth 7 and 8 after 3d and after each fault experiment; no budget is set (G8). Copying comes back at the first agent-native workflow, or earlier if the search keeps replaying a long, costly prefix: first a copy's correctness against replay, then its cost (G6, BER-2217) |

---

## 📘 7. Tiger Style 101

Tiger Style is TigerBeetle's coding style. It ranks safety first, performance second and developer experience third, and pairs that with deterministic simulation testing: the real program runs in a simulated world that can be replayed from a seed.

| Rule | What it means | Here |
| --- | --- | --- |
| 🛡️ Assertions everywhere | At least two per function on average: arguments, results, invariants. Pair them, check the positive and the negative space, and crash on corrupt state rather than run on | `assert-the-invariants`; step 4f |
| 📏 Limit everything | Every loop, queue, retry and wait has an upper bound; every request has a deadline | `limit-everything`; steps 4h and 5 |
| 🧱 Simple control flow | No recursion, functions of at most 70 lines, shallow nesting, control flow in the parent and pure work in helpers | `simple-control-flow`; step 4e |
| 📦 Static allocation | Memory is allocated at start-up, never while running. In TypeScript this becomes bounded collections with limits in configuration | `limit-everything` |
| 🧰 Few dependencies | Every dependency earns its place; the toolchain stays small | `few-dependencies` |
| 🏷️ Names carry units | Whole words, units last, most significant first: `timeoutMs`, `latencyMsMax` | `names-carry-units` |
| 📐 Performance by estimate | Sketch the cost before building, measure after; the simulator has a budget too | `performance-is-budgeted`; S1 |
| 🎲 Deterministic simulation | The real code runs on a simulated clock, network and disk driven by one seed, with faults injected and checks after every step; a failure replays exactly | Determinism group; steps 1–6 |

💡 **How the two fit:** assertions say what must hold, and the simulator runs those assertions through many hostile, replayable schedules; each catches failures the other misses.

---

## 📚 8. Sources

| Source | What it gave this plan |
| --- | --- |
| [TigerBeetle: TIGER_STYLE.md](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md) | The style rules in section 7 and PRINCIPLES.md |
| [TigerBeetle: safety](https://docs.tigerbeetle.com/concepts/safety/) | How the VOPR simulates the cluster and checks it (F1) |
| [TigerBeetle: vopr.zig](https://github.com/tigerbeetle/tigerbeetle/blob/main/src/vopr.zig) | The simulator's entry point: one seed, faults, a liveness mode |
| [TigerBeetle: A descent into the Vörtex](https://tigerbeetle.com/blog/2025-02-13-a-descent-into-the-vortex/) | Why they also run an intentionally non-deterministic harness beside simulation |
| [FoundationDB: simulation and testing](https://apple.github.io/foundationdb/testing.html) | One process, swappable network and disk, faults (F1, K3) |
| [Will Wilson: Testing distributed systems with deterministic simulation](https://www.youtube.com/watch?v=4fFDFbi3toc) | The FoundationDB approach in depth, Strange Loop 2014 |
| [Antithesis: deterministic hypervisor](https://antithesis.com/blog/deterministic_hypervisor/) | Determinism at the machine level, unchanged programs (F2) |
| [Antithesis: how Antithesis works](https://antithesis.com/docs/introduction/how_antithesis_works/) | Simulated network and storage, fault injection, exploration |
| [Effect 4 source](https://github.com/Effect-TS/effect-smol) | Scheduler, Clock and Random as replaceable services (F3) |
| [Effect-TS/tsgo](https://github.com/Effect-TS/tsgo) | The Effect-patched tsrs and oxlint, and how the patches are kept thin (F15, D4) |
| [Effect language service](https://github.com/Effect-TS/language-service) | The catalogue of Effect's own diagnostics (F14) |
| [pingdotgg/ts-rust](https://github.com/pingdotgg/ts-rust) | Effect diagnostics built into another Rust port of TypeScript; not chosen, because the lint runs on tsrs and a second checker beside it was ruled out (D4) |
| [@slack/socket-mode](https://www.npmjs.com/package/@slack/socket-mode) | The SDK's undici WebSocket, keepalive and reconnect on real timers (F11, D1) |
| [fast-check](https://fast-check.dev/) | Generation and shrinking (F6, P5) |
| [oxlint: type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware.html) | The type-aware rules in the ratchet (F8, F13) |
