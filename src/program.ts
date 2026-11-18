// The program after the process boundary. main and both simulators call this
// exact composition; only the services beneath it differ.
import { Effect } from "effect";

import type { ListenerConfig } from "./config.ts";
import { channelInstructions } from "./format.ts";
import type { Log } from "./log.ts";
import { ChannelServer } from "./mcp.ts";
import { readSaved, runShell } from "./shell.ts";
import { SlackApi } from "./slack-api.ts";

export function runListener(
  config: ListenerConfig,
  tokens: { readonly bot: string; readonly app: string },
  log: Log,
) {
  return Effect.gen(function* () {
    const api = yield* SlackApi.make(tokens.bot, tokens.app);
    const sink = yield* ChannelServer.make({
      name: config.serverName,
      version: "0.0.0",
      instructions: channelInstructions,
      log,
    });
    const saved = yield* readSaved(config.stateFile);
    yield* log(`watching ${config.core.channel} as ${config.serverName}`);
    yield* runShell(config, { api, sink, log }, saved);
  });
}
