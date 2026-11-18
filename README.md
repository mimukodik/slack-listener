<h1 align="center">slack-listener</h1>

<p align="center">
  <a href="RULES.md">Rules</a> · <a href="PRINCIPLES.md">Principles</a> · <a href="docs/en/specification.md">Specification</a> · <a href="docs/en/slack-app.md">Slack app</a> · <a href="DECISIONS.md">Decisions</a> · <a href="README.hu.md">Magyarul</a>
</p>

A Claude Code channel server that wakes a session when someone posts in a Slack channel, so no session has to poll. Each new message from an allowed sender arrives in the session that started the listener, quoted as data, with its author, `ts` and `thread_ts`.

- **Gated on the sender.** Only the channel you name, and only the people and bots you list. Your own side's agent posts never wake your session, so two sides' agents can share a channel without waking themselves.
- **Data, not instructions.** Every line of a message is quoted with `> `, so sender text cannot pass for the listener's own framing. The listener never declares the permission relay.
- **Nothing lost.** A disconnect, a sleeping laptop or a crash is followed by a catch-up from Slack's history. A message the session may already have seen comes again marked `possible_duplicate`.
- **Reads only.** Answering in a thread through the tool is planned (RULES.md, step 2) and switched off.
- **Checked by simulation.** The production Effect program runs on a seeded fake world, with actual session output and Slack acknowledgements checked. A bounded exhaustive pass replays every valid action prefix.

## Run it

Node 26 or later, pnpm, and the [1Password CLI](https://developer.1password.com/docs/cli/) for the tokens.

1. Create a Slack app and a config file: [docs/en/slack-app.md](docs/en/slack-app.md). Keep the config outside any repository; tokens are `op://` references, never values.
2. Install and check the setup:

   ```sh
   pnpm install
   node src/main.ts --check --config <config.json>
   ```

3. Write an `mcp.json` outside any project, so that no other session starts a second listener:

   ```json
   {
     "mcpServers": {
       "slack-listener": {
         "command": "node",
         "args": ["<checkout>/src/main.ts", "--config", "<config.json>"]
       }
     }
   }
   ```

4. Start the receiving session with it:

   ```sh
   claude --mcp-config <mcp.json> \
     --dangerously-load-development-channels server:slack-listener
   ```

Channels are a research preview: interactive sessions only, with a confirmation prompt at start. A lock file refuses a second listener on the same channel. `--demo` in place of `--config` sends one sample event without Slack.

## What it trusts

The channel id and the configured user and bot ids. Slack's `app_id` marking on agent posts: if Slack stopped marking them, the own side's agents would be heard again (R10). 1Password for the tokens. The session it feeds: events go to whoever started it.

## Develop

```sh
pnpm lint            # format, oxlint, typecheck
pnpm test            # unit tests, conformance, a bounded exhaustive pass
pnpm sim 2000 120    # the seeded simulator: seeds x actions
pnpm exhaustive 7    # every action sequence up to 7
```

A change to behaviour updates [RULES.md](RULES.md) and both specifications in the same pull request, and records why in [DECISIONS.md](DECISIONS.md). The docs exist in English and Hungarian; if they differ, the English one is right. [PRINCIPLES.md](PRINCIPLES.md) says how the code is built: Tiger Style and deterministic simulation testing, with how each principle is enforced. [AGENTS.md](AGENTS.md) holds the working rules.

## License

[MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
