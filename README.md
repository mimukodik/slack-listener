# slack-listener

Pushes messages from one Slack channel into a Claude Code session, so no session
has to poll. The tool and its docs live in
[`packages/slack-listener`](packages/slack-listener/README.md); its rules are in
[`RULES.md`](packages/slack-listener/RULES.md).

This repository is temporary. The package is laid out exactly as it will sit in
`mimukodik/agent-native` (`packages/slack-listener`), with agent-native's Node,
pnpm, oxfmt, oxlint and tsrs versions, so the move back is a copy plus wiring:

- in `package.json`, replace `tsrs` and `vitest` with `@muhely/tsc: workspace:*`
  and `vitest: catalog:`, and use agent-native's `lint` script and guard scripts;
- drop this root's `package.json`, `pnpm-workspace.yaml`, `.oxlintrc.json`,
  `vitest.shared.ts` and workflow; agent-native's own take their place.

```sh
pnpm install
pnpm lint
pnpm test
pnpm sim 2000 120
```
