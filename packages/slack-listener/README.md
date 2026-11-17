# slack-listener

Listens to one Slack channel and pushes each new message into the Claude Code
session that started it, so no session has to poll. Messages arrive quoted as data,
with author, `ts` and `thread_ts`. It reads only; it does not post yet.

Magyarul: [README.hu.md](README.hu.md).

- [`RULES.md`](RULES.md): the numbered rules, the source of truth for behaviour.
- Specification: [English](docs/en/specification.md),
  [magyar](docs/hu/specifikacio.md).
- Creating your own Slack app and config: [English](docs/en/slack-app.md),
  [magyar](docs/hu/slack-app.md).

## Run it

One instance per person, each with its own Slack app.

1. Create the app and the config file: [`docs/en/slack-app.md`](docs/en/slack-app.md).
   Keep the config outside any repository; tokens are `op://` references only.
2. Check the setup:

   ```sh
   node packages/slack-listener/src/main.ts --check --config <config.json>
   ```

3. Write an `mcp.json` outside any project, so that no other session starts a
   second listener:

   ```json
   {
     "mcpServers": {
       "slack-listener": {
         "command": "node",
         "args": [
           "<checkout>/packages/slack-listener/src/main.ts",
           "--config",
           "<config.json>"
         ]
       }
     }
   }
   ```

4. Start the receiving session with it:

   ```sh
   claude --mcp-config <mcp.json> \
     --dangerously-load-development-channels server:slack-listener
   ```

   Channels are a research preview: interactive sessions only, with a
   confirmation prompt at start. A lock file refuses a second listener on the
   same channel. `--demo` in place of `--config` sends one sample event without
   Slack, to try the route.

## What it trusts

The channel id and the configured user and bot ids. Slack's `app_id` marking on
agent posts (if Slack stopped marking them, the own side's agents would be heard
again; RULES.md R10). 1Password for tokens. The session it feeds: events go to
whoever started it, and it relays no permission prompts.

## Method and what it gave

The core is a pure `step(state, event, now)`; the shell runs its effects (Slack,
timers, the session, the state file). `src/sim` runs the core against a fake
Slack with seeded faults, fast-check drives the choices and shrinks failures,
the safety rules are checked after every step and the progress rules at the end
of each run, and two controls (a build that delivers
nothing, a build that delivers everything) must fail. Beside the sampling, a bounded
exhaustive pass (`pnpm exhaustive 7`) runs every sequence of up to 7 actions over an
alphabet of 8 (two thread starters, a reply in each, an edit, a disconnect, a crash,
a duplicate): 87,796 sequences, no violation; up to 8 actions, 470,620. A conformance
test compares the fake Slack with recorded real events.

- Gave: four real core bugs found before any live run, each now a kept scenario
  test in `src/core.spec.ts` (an edit lost to a crash during catch-up,
  out-of-order release, an older edit after a newer one, a late redelivery out
  of order).
- Gave: one hard limit made explicit (reply edits during a gap; RULES.md, out
  of scope) instead of a silent gap.
- Cost: the fake Slack is a second model to keep honest; one correction so far
  (deleted thread parents stay as tombstones), checked only against the Slack
  docs until recorded envelopes replace guesses.
- Cost: about a third of the build time went to the simulator and oracle, and
  one of the finds was the oracle's own bug.
- Not used: TLA+ (the fast-check model of two settling instances covers step
  2's one concurrency question) and machine-checked proofs (out of proportion
  for this tool). Mutation checks are done by hand: each new or tightened check
  is shown to fail on a deliberately broken build, with counts in the PR.

### Changes after the first green run

A check can be passed by weakening it. Every change to `RULES.md`, the
simulator's checkers or the fake Slack after the first green run, with its cause:

| When         | What                                                                                                                                                                             | Direction            | Cause                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------- |
| before PR #1 | fake: a deleted thread parent stays as a tombstone                                                                                                                               | fake corrected       | Slack docs                                                                                      |
| 11-17        | R12 becomes a loop fuse of 20; R14 removed                                                                                                                                       | rule changed         | Greg: limiting the rate is the wrong lever                                                      |
| 11-17        | step 2 posting gate: from "until Greg has seen the rules" to "after step 1's live proof and the settling simulation"; `chat:write` granted from the start, posting off in config | rule changed         | Greg's decision                                                                                 |
| 11-17, PR #1 | R9 replaced by R16: parent quoted only for allowed authors                                                                                                                       | stricter             | review: a stranger's text reached the session                                                   |
| 11-17, PR #1 | out of scope: Slack reordering wider than 3 s                                                                                                                                    | rule narrowed        | review: the 3 s hold cannot order more                                                          |
| 11-17, PR #1 | R2: possible duplicates bounded, at most one per crash                                                                                                                           | checker stricter     | before, any number was accepted after one crash                                                 |
| 11-17, PR #1 | one sleep at a time, run limit 12 h → 48 h                                                                                                                                       | fault model narrower | stacked sleeps outran the run limit                                                             |
| 11-17, PR #1 | runs end only with a live socket                                                                                                                                                 | checker stricter     | runs ended on a dead socket and skipped R7                                                      |
| 11-17, PR #1 | R2 by content, duplicates bounded by crashes, R3 line by line, thread ids against the fake, every reconnect wait                                                                 | checkers stricter    | review: checkers were weak                                                                      |
| 11-17, PR #1 | fake: laptop sleep, slow and failing API, forged framing, same-text edits                                                                                                        | fake harsher         | review                                                                                          |
| 11-17, PR #1 | while the API is failing, a call fails half the time, not always; disconnects 4 % of actions, not 6 %                                                                            | fault model softer   | mixed answers exercise stale catch-up replies; the sleep fault took 2 % of the disconnect share |
| 11-17, PR #2 | R16 replaced by R17: parent quoted for any configured author                                                                                                                     | rule wider           | R16 was false for our own coordinator's threads; approved by bob2                               |
| 11-17, PR #2 | out of scope: a same-text edit made during a gap                                                                                                                                 | rule narrowed        | catch-up cannot tell it from a real edit                                                        |
| 11-17, PR #2 | R17 notes it trusts who posted, not where the text came from                                                                                                                     | rule clarified       | review                                                                                          |
| 11-17, PR #2 | bob2 approves rule changes; Greg only for wider waking, new speaking or weaker R3/R6                                                                                             | approval looser      | Greg, via bob2                                                                                  |
| 11-17, PR #2 | R8 against the rule's 60 s; framing with its own line breaks; header line count; parent decision shared with the shell                                                           | checkers stricter    | review: checks that could not fail                                                              |
| 11-17, PR #3 | R7 excuses a reply edit only when Slack never pushed it live                                                                                                                     | checker stricter     | review: the excuse covered live edits too                                                       |

## Changing behaviour

A change to behaviour updates `RULES.md` and both specifications in the same
pull request. A changed rule gets a new id; a removed id is not reused. The docs
exist in English and Hungarian; if they differ, the English one is right.
