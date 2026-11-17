#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { Effect } from "effect";

import {
  defaultConfigPath,
  loadConfig,
  type ListenerConfig,
} from "./config.ts";
import { channelInstructions, renderDelivery } from "./format.ts";
import { ChannelServer } from "./mcp.ts";
import { readSaved, Shell } from "./shell.ts";
import { redact, SlackApi } from "./slack-api.ts";
import { msToTs } from "./slack.ts";

function log(line: string): void {
  process.stderr.write(
    `${new Date().toISOString()} slack-listener ${redact(line)}\n`,
  );
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
      `op read ${reference} failed: ${redact(String((error as { stderr?: string }).stderr ?? (error as Error).message)).trim()}`,
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

function acquireLock(path: string): () => void {
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

async function check(config: ListenerConfig, api: SlackApi): Promise<number> {
  const results = await Effect.runPromise(
    Effect.all(
      {
        auth: Effect.result(api.teamUrl()),
        channel: Effect.result(api.channelInfo(config.core.channel)),
        socket: Effect.result(api.openConnection()),
      },
      { concurrency: 3 },
    ),
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
  if (results.channel._tag === "Success") {
    report(
      `channel ${config.core.channel}`,
      results.channel.success.isMember,
      results.channel.success.isMember
        ? `#${results.channel.success.name}, bot is a member`
        : `#${results.channel.success.name}, bot is NOT a member: /invite it`,
    );
  } else {
    report(
      `channel ${config.core.channel}`,
      false,
      `${results.channel.failure.reason} (is the bot invited?)`,
    );
  }
  report(
    "app token (apps.connections.open)",
    results.socket._tag === "Success",
    results.socket._tag === "Success"
      ? "socket url issued"
      : results.socket.failure.reason,
  );
  return failed === 0 ? 0 : 1;
}

function demo(): void {
  const sink = new ChannelServer({
    name: "slack-listener",
    version: "0.0.0",
    instructions: channelInstructions,
    input: process.stdin,
    output: process.stdout,
    onClosed: () => process.exit(0),
    log,
  });
  const nowMs = Date.now();
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
  const timer = setInterval(() => {
    if (!sink.ready) return;
    clearInterval(timer);
    setTimeout(() => {
      void Effect.runPromise(
        Effect.result(sink.notify(rendered.content, rendered.meta)),
      ).then((result) =>
        log(
          result._tag === "Success"
            ? "demo event sent"
            : `demo event failed: ${result.failure.reason}`,
        ),
      );
    }, 3000);
  }, 200);
}

async function main(): Promise<void> {
  if (process.argv.includes("--demo")) {
    demo();
    return;
  }
  const config = loadConfig(argValue("--config") ?? defaultConfigPath);
  const api = new SlackApi(
    readToken(config.botTokenRef, "xoxb-"),
    readToken(config.appTokenRef, "xapp-"),
  );
  if (process.argv.includes("--check")) {
    process.exitCode = await check(config, api);
    return;
  }
  const release = acquireLock(config.lockFile);
  let shell: Shell | null = null;
  const shutdown = (reason: string) => {
    log(`stopping: ${reason}`);
    shell?.stop();
    release();
    process.exit(0);
  };
  const sink = new ChannelServer({
    name: config.serverName,
    version: "0.0.0",
    instructions: channelInstructions,
    input: process.stdin,
    output: process.stdout,
    onClosed: () => shutdown("the session closed stdin"),
    log,
  });
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  const fail = (reason: string) => {
    log(`fatal: ${reason}`);
    shell?.stop();
    release();
    process.exit(1);
  };
  process.on("unhandledRejection", (error) =>
    fail(
      `unhandled: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
  shell = new Shell(config, api, sink, log, fail);
  shell.start(readSaved(config.stateFile));
  log(`watching ${config.core.channel} as ${config.serverName}`);
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
