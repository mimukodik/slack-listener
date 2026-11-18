#!/usr/bin/env node
// The process boundary: arguments, the configuration, the tokens and the lock
// file use Node directly, then the listener runs as an Effect program on the
// Node layers. Everything after the boundary reaches the world through
// services (src/shell.ts), so the simulator can run it on its own layers.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  NodeFileSystem,
  NodeRuntime,
  NodeStdio,
} from "@effect/platform-node-shared";
import { Cause, Clock, Data, Deferred, Effect, Exit, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Socket } from "effect/socket";

import {
  defaultConfigPath,
  loadConfig,
  type ListenerConfig,
} from "./config.ts";
import { channelInstructions, renderDelivery } from "./format.ts";
import { makeLog, type Log } from "./log.ts";
import { ChannelServer } from "./mcp.ts";
import { readSaved, runShell } from "./shell.ts";
import { redact, SlackApi } from "./slack-api.ts";
import { msToTs } from "./slack.ts";

// The listener cannot start or must stop; the reason is logged and the
// process exits 1.
class Fatal extends Data.TaggedError("Fatal")<{ reason: string }> {}

function message(error: unknown): string {
  if (typeof error === "object" && error !== null && "reason" in error)
    return String(error.reason);
  return error instanceof Error ? error.message : String(error);
}

function readToken(reference: string, expectedPrefix: string): string {
  let value: string;
  try {
    value = execFileSync("op", ["read", "--no-newline", reference], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `op read ${reference} failed: ${redact(String((error as { stderr?: string }).stderr ?? message(error))).trim()}`,
    );
  }
  if (!value.startsWith(expectedPrefix))
    throw new Error(`${reference} does not hold a ${expectedPrefix}… token`);
  return value;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Takes the lock file and returns its release. A second listener on the same
// channel would split Slack's events between the two.
function takeLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    if (
      Number.isInteger(holder) &&
      holder > 0 &&
      holder !== process.pid &&
      processAlive(holder)
    ) {
      throw new Error(
        `another listener (pid ${holder}) already watches this channel; two would split Slack's events between them`,
      );
    }
    rmSync(path, { force: true });
  }
  throw new Error(
    "could not take the lock file: another listener is starting at the same moment",
  );
}

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function atBoundary<A>(run: () => A): Effect.Effect<A, Fatal> {
  return Effect.try({
    try: run,
    catch: (error) => new Fatal({ reason: redact(message(error)) }),
  });
}

function check(
  config: ListenerConfig,
  api: SlackApi,
): Effect.Effect<void, Fatal> {
  return Effect.gen(function* () {
    const results = yield* Effect.all(
      {
        auth: Effect.result(api.teamUrl()),
        channel: Effect.result(api.canRead(config.core.channel)),
        socket: Effect.result(api.openConnection()),
      },
      { concurrency: 3 },
    );
    let failed = 0;
    const report = (label: string, ok: boolean, detail: string) => {
      if (!ok) failed += 1;
      process.stdout.write(`${ok ? "ok  " : "FAIL"} ${label}: ${detail}\n`);
    };
    report(
      "bot token (auth.test)",
      results.auth._tag === "Success",
      results.auth._tag === "Success"
        ? results.auth.success
        : results.auth.failure.reason,
    );
    report(
      `channel ${config.core.channel} (#${config.channelName})`,
      results.channel._tag === "Success",
      results.channel._tag === "Success"
        ? "bot can read its history"
        : results.channel.failure.reason === "not_in_channel" ||
            results.channel.failure.reason === "channel_not_found"
          ? `${results.channel.failure.reason}: /invite the bot in the channel`
          : results.channel.failure.reason,
    );
    report(
      "app token (apps.connections.open)",
      results.socket._tag === "Success",
      results.socket._tag === "Success"
        ? "socket url issued"
        : results.socket.failure.reason,
    );
    if (failed > 0)
      return yield* new Fatal({ reason: `--check: ${failed} check(s) failed` });
  });
}

function demo(log: Log) {
  return Effect.gen(function* () {
    const sink = yield* ChannelServer.make({
      name: "slack-listener",
      version: "0.0.0",
      instructions: channelInstructions,
      log,
    });
    yield* Deferred.await(sink.initialized);
    yield* Effect.sleep("3 seconds");
    const nowMs = yield* Clock.currentTimeMillis;
    const rendered = renderDelivery(
      {
        key: "demo",
        kind: "message",
        channel: "CDEMO0001",
        ts: msToTs(nowMs),
        threadTs: msToTs(nowMs - 60_000),
        isReply: true,
        user: "UDEMO0001",
        text: "Demo message from slack-listener --demo. Tell your user it arrived, with its ts and thread_ts. Do nothing else.",
        postedAtMs: nowMs,
        editedAtMs: null,
        possibleDuplicate: false,
      },
      {
        userName: "demo",
        channelName: "demo",
        parent: {
          shown: true,
          authorId: "UDEMO0002",
          authorName: "demo parent",
          line: "Demo thread parent",
        },
        permalink: null,
      },
    );
    const sent = yield* Effect.result(
      sink.notify(rendered.content, rendered.meta),
    );
    yield* log(
      sent._tag === "Success"
        ? "demo event sent"
        : `demo event failed: ${sent.failure.reason}`,
    );
    yield* Deferred.await(sink.closed);
  });
}

function listen(log: Log) {
  return Effect.gen(function* () {
    const config = yield* atBoundary(() =>
      loadConfig(argValue("--config") ?? defaultConfigPath),
    );
    const tokens = yield* atBoundary(() => ({
      bot: readToken(config.botTokenRef, "xoxb-"),
      app: readToken(config.appTokenRef, "xapp-"),
    }));
    const api = yield* SlackApi.make(tokens.bot, tokens.app);
    if (process.argv.includes("--check")) return yield* check(config, api);
    yield* Effect.acquireRelease(
      atBoundary(() => takeLock(config.lockFile)),
      (release) => Effect.sync(release),
    );
    const sink = yield* ChannelServer.make({
      name: config.serverName,
      version: "0.0.0",
      instructions: channelInstructions,
      log,
    });
    const saved = yield* readSaved(config.stateFile).pipe(
      Effect.mapError((error) => new Fatal({ reason: error.reason })),
    );
    yield* log(`watching ${config.core.channel} as ${config.serverName}`);
    yield* runShell(config, { api, sink, log }, saved).pipe(
      Effect.mapError((error) => new Fatal({ reason: error.reason })),
    );
  });
}

const program = Effect.gen(function* () {
  const log = yield* makeLog;
  const run = process.argv.includes("--demo") ? demo(log) : listen(log);
  yield* run.pipe(
    Effect.scoped,
    Effect.onInterrupt(() => log("stopping: interrupted")),
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : log(`fatal: ${redact(message(Cause.squash(cause)))}`),
    ),
  );
});

const layers = Layer.mergeAll(
  NodeFileSystem.layer,
  NodeStdio.layer,
  FetchHttpClient.layer,
  Socket.layerWebSocketConstructorGlobal,
);

// Exits 0 when the session ends or a signal stops the listener, 1 when it
// failed, at once, as before the listener ran on Effect.
NodeRuntime.runMain(program.pipe(Effect.provide(layers)), {
  disableErrorReporting: true,
  teardown: (exit) =>
    process.exit(
      Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) ? 1 : 0,
    ),
});
