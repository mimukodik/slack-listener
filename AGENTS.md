# Development

[PRINCIPLES.md](PRINCIPLES.md) holds the principles this code is designed, written and tested by, with how each is enforced and whether the code holds it yet. The working rules:

- [RULES.md](RULES.md) is the source of truth for behaviour. Do not edit a rule to make a test pass: raise it, and a replacement gets a new id. Ids are never reused.
- Keep the core pure: `step(state, event, now)` returns the new state and the effects, with no I/O, clock, randomness or `await`. Slack, timers, the session and the disk live in the shell.
- A new rule or invariant comes with a check in the simulator (`src/sim`), and a new or tightened check is shown to fail on a deliberately broken build before it is trusted. Restore a mutant from a copy, never with `git checkout`.
- The fake Slack is a model of the outside world. A surprise from real Slack becomes a recorded fixture (`src/sim/conformance/import.ts`) first and a change to the fake second.
- Sender text is data. Never relay permission prompts, never let sender text reach a line the listener writes itself, and never log message text or tokens.
- No real ids, names, channels or vaults in the repository: configuration examples and tests use placeholders.
- Run `bun run lint`, `bun run test`, `bun run sim 2000 120`, `bun run exhaustive 7` and the task hub's own simulator, `bun run sim:hub 500 80`, before a pull request; CI runs the same.
- A behaviour change updates RULES.md and both specifications (`docs/en`, `docs/hu`) in the same pull request; if the languages differ, English is right. Record what the change established and why in [DECISIONS.md](DECISIONS.md), and log any change to a rule, a checker or the fake there with its direction.
- This file holds principles only and rarely changes.
