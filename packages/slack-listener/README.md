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
every rule is checked after every step, and two controls (a build that delivers
nothing, a build that delivers everything) must fail.

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
  2's one concurrency question) and mutation testing (wanted; the two controls
  are its cheap stand-in).

## Changing behaviour

A change to behaviour updates `RULES.md` and both specifications in the same
pull request. A changed rule gets a new id; a removed id is not reused. The docs
exist in English and Hungarian; if they differ, the English one is right.
