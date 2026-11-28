<h1 align="center">slack-listener</h1>

<p align="center">
  <a href="RULES.md">Rules</a> · <a href="PRINCIPLES.md">Principles</a> · <a href="docs/en/specification.md">Specification</a> · <a href="docs/en/slack-app.md">Slack app</a> · <a href="DECISIONS.md">Decisions</a> · <a href="README.hu.md">Magyarul</a>
</p>

**New here?** [What we tried while building this listener, what held up, and what is still open.](experiments/README.md)

A Claude Code channel server that wakes a session when someone posts in a Slack channel, so no session has to poll. Each new message from an allowed sender arrives in the session that started the listener, quoted as data, with its author, `ts` and `thread_ts`.

- **Gated on the sender.** Only the channel you name, and only the people and bots you list. Your own side's agent posts never wake your session, so two sides' agents can share a channel without waking themselves.
- **Data, not instructions.** Every line of a message is quoted with `> `, so sender text cannot pass for the listener's own framing. The listener never declares the permission relay.
- **Nothing lost.** A disconnect, a sleeping laptop or a crash is followed by a catch-up from Slack's history. A message the session may already have seen comes again marked `possible_duplicate`.
- **Reads only.** Answering in a thread through the tool is planned (RULES.md, step 2) and switched off.
- **Checked by simulation.** The production Effect program runs on a seeded fake world, with actual session output and Slack acknowledgements checked. A bounded exhaustive pass replays every valid action prefix.

## What comes together here

The listener is small on purpose. We use it to work out how to build software that coding agents can change quickly without breaking what people rely on. These ideas are combined:

- **Rules before code.** [RULES.md](RULES.md) says in user terms what the tool must do, in numbered rules. Its first version was written before any code. A rule is never edited to make a test pass, and an id is never reused.
- **A pure core, I/O at the edge.** One function decides: `step(state, event, now)` in [src/core.ts](src/core.ts). The shell around it carries the decisions out.
- **Effect in the shell.** The listener is one [Effect](https://effect.website/) program that reaches the clock, the WebSocket, HTTP, the file system and the session through services.
- **Deterministic simulation of the whole program.** The simulator runs that same program on a fake world, with a seeded scheduler and a virtual clock. The same seed replays the same run, and the rules are checked on what the session and Slack observe. An exhaustive pass also runs every valid sequence of up to 7 actions, drawn from a fixed alphabet of eleven action kinds.
- **Models checked beside the code.** Two [TLA+ models](spec/listener/README.md) cover the listener's delivery, catch-up and reaction-mark rules. They were written from the rules alone, and the TLC model checker explores every state of each model within set bounds. For the task hub, a second tool built beside the listener, CI replays [the model's paths](spec/tasks/README.md) against the real code.
- **A check is proven on a planted bug before it is trusted.** The bar for a check, lint rule or test is that it catches a deliberately broken version of the code. [PRINCIPLES.md](PRINCIPLES.md) says where this is not met yet.
- **Tiger Style as the direction.** [PRINCIPLES.md](PRINCIPLES.md) follows TigerBeetle's [Tiger Style](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md): safety first, then performance, then developer experience. For each principle it says how it is enforced and whether the code holds it today.
- **One action definition, every surface.** In the task hub each action is defined once, and REST with its OpenAPI document, MCP tools, RPC and client atoms are generated from that definition ([src/action](src/action)).

[What we tried, what we kept and what we dropped](experiments/README.md) has the evidence for each.

## Run it

Bun 1.4.5 or later and the [1Password CLI](https://developer.1password.com/docs/cli/) for the tokens.

1. Create a Slack app and a config file: [docs/en/slack-app.md](docs/en/slack-app.md). Keep the config outside any repository; tokens are `op://` references, never values.
2. Install and check the setup:

   ```sh
   bun install
   bun src/main.ts --check --config <config.json>
   ```

3. Write an `mcp.json` outside any project, so that no other session starts a second listener:

   ```json
   {
     "mcpServers": {
       "slack-listener": {
         "command": "bun",
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
bun run lint            # format, oxlint, typecheck
bun run test            # unit tests, conformance, a bounded exhaustive pass
bun run sim 2000 120    # the seeded simulator: seeds x actions
bun run exhaustive 7    # every action sequence up to 7
```

A change to behaviour updates [RULES.md](RULES.md) and both specifications in the same pull request, and records why in [DECISIONS.md](DECISIONS.md). The docs exist in English and Hungarian; if they differ, the English one is right. [PRINCIPLES.md](PRINCIPLES.md) says how the code is built: Tiger Style and deterministic simulation testing, with how each principle is enforced. [AGENTS.md](AGENTS.md) holds the working rules.

## License

[MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
