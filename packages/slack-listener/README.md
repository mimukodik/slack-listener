# slack-listener

Listens to one Slack channel and pushes each message into the Claude Code session
that started it, so no session has to poll. It reads only; it never posts.
`RULES.md` holds the numbered rules it is built and tested against.

## What reaches the session

A message from one of the configured people or bots in the watched channel arrives as
one channel event: author id and name, `ts`, `thread_ts`, the posting time, and for a
thread reply the parent's first line and a link. The text is quoted as data from that
sender, never as an instruction. A real edit arrives once as `kind=edit`. Deletes,
joins, other channels, unknown senders and the own side's agent posts are dropped.

Sides: each instance has an own side (you, and agents posting as you) and an other
side. Everything the other side posts is delivered, typed or agent. From the own side
only typed posts are delivered: a post carrying an app id is treated as an agent post.

## Set it up (one instance per person)

1. Create a Slack app for your side, from a manifest:

   ```yaml
   display_information:
     name: slack-listener (your name)
   features:
     bot_user:
       display_name: slack-listener
   oauth_config:
     scopes:
       bot: [groups:history, channels:history, users:read]
   settings:
     event_subscriptions:
       bot_events: [message.groups, message.channels]
     socket_mode_enabled: true
   ```

   Install it, create an app-level token with `connections:write`, and invite the
   bot to the channel (`/invite @slack-listener`). Each instance needs its own app:
   Slack spreads one app's events across all its open connections.

2. Put both tokens in 1Password and write `~/.config/slack-listener/config.json`:

   ```json
   {
     "channel": "C0000000000",
     "channelName": "my-channel",
     "ownPeople": ["U0000000001"],
     "otherPeople": ["U0000000002"],
     "otherBots": [],
     "tokens": {
       "bot": "op://<vault>/slack-listener/bot_token",
       "app": "op://<vault>/slack-listener/app_token"
     }
   }
   ```

   Token fields take `op://` references only; the tool reads them with `op read`
   and never prints or stores them. State goes to `~/.local/state/slack-listener/`.

3. Check it: `node packages/slack-listener/src/main.ts --check` reports the bot
   token, channel membership and the Socket Mode token.

4. Write `~/.config/slack-listener/mcp.json`, outside any project so that no other
   session starts a second listener:

   ```json
   {
     "mcpServers": {
       "slack-listener": {
         "command": "node",
         "args": ["<checkout>/packages/slack-listener/src/main.ts"]
       }
     }
   }
   ```

5. Start the receiving session with it:

   ```sh
   claude --mcp-config ~/.config/slack-listener/mcp.json \
     --dangerously-load-development-channels server:slack-listener
   ```

   Channels are a research preview: interactive sessions only, and a confirmation
   prompt at start. A lock file refuses a second listener on the same channel.
   `--demo` instead of the config sends one sample event without Slack, to try the
   route.

## What it trusts

The channel id and the configured user and bot ids. Slack's `app_id` marking on
agent posts (if Slack stopped marking them, the own side's agents would be heard
again; RULES.md R10). 1Password for tokens. The session it feeds: events go to
whoever started it, and it relays no permission prompts.

## Method and what it gave

The core is a pure `step(state, event, now)`; the shell runs its effects (Slack,
timers, the session, the state file). `src/sim` runs the core against a fake Slack
with seeded faults: duplicates, late and re-sent envelopes, disconnects, crashes
between effects, failing API calls and sessions. fast-check drives the choices and
shrinks a failure to a short trace. Every rule is checked after every step, coverage
counters must all be non-zero, and two controls (a build that delivers nothing, a
build that delivers everything) must fail.

- Gave: four real core bugs found before any live run, each now a kept scenario
  test in `src/core.spec.ts` (an edit lost to a crash during catch-up, out-of-order
  release, an older edit after a newer one, a late redelivery out of order).
- Gave: one hard limit made explicit (reply edits during a gap; RULES.md, out of
  scope) instead of a silent gap.
- Cost: the fake Slack is a second model to keep honest; one correction so far
  (deleted thread parents stay as tombstones), and it is checked only against the
  Slack docs until recorded envelopes replace guesses.
- Cost: about a third of the build time went to the simulator and oracle, and one
  of the finds was the oracle's own bug.
- Not used: TLA+ (the fast-check model of two settling instances covers step 2's
  one concurrency question) and mutation testing (wanted; the two controls are its
  cheap stand-in).
