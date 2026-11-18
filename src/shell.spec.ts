import {
  Cause,
  Deferred,
  Effect,
  FiberMap,
  FileSystem,
  Layer,
  Queue,
  Sink,
  Stdio,
  Stream,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { Socket } from "effect/socket";
import { describe, expect, it } from "vitest";

import { ConfigError, parseConfig, type ListenerConfig } from "./config.ts";
import { defaultLimits, type TimerName } from "./core.ts";
import { channelInstructions } from "./format.ts";
import { makeLog } from "./log.ts";
import { ChannelServer } from "./mcp.ts";
import { replaceTimer, runShell } from "./shell.ts";
import { redact, SlackApi } from "./slack-api.ts";
import { msToTs } from "./slack.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// The session's side of stdio: lines the test sends, lines the listener wrote.
function session() {
  const lines: Array<Record<string, unknown>> = [];
  const stderr: string[] = [];
  const stdin = Effect.runSync(Queue.unbounded<Uint8Array, Cause.Done>());
  const layer = Stdio.layerTest({
    stdin: Stream.fromQueue(stdin),
    stdout: () =>
      Sink.forEach((chunk: string | Uint8Array) =>
        Effect.sync(() => {
          const text =
            typeof chunk === "string" ? chunk : decoder.decode(chunk);
          for (const line of text.split("\n"))
            if (line.trim() !== "") lines.push(JSON.parse(line));
        }),
      ),
    stderr: () =>
      Sink.forEach((chunk: string | Uint8Array) =>
        Effect.sync(() => {
          stderr.push(
            typeof chunk === "string" ? chunk : decoder.decode(chunk),
          );
        }),
      ),
  });
  const send = (message: object) =>
    Effect.runSync(
      Queue.offer(stdin, encoder.encode(`${JSON.stringify(message)}\n`)),
    );
  const close = () => Effect.runSync(Queue.end(stdin));
  return { layer, lines, stderr, send, close };
}

async function until(condition: () => boolean, label: string) {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > 3000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18" },
};
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

describe("channel server", () => {
  it("R3: declares the channel capability and never the permission relay", async () => {
    const stdio = session();
    const program = Effect.gen(function* () {
      yield* ChannelServer.make({
        name: "slack",
        version: "0.0.0",
        instructions: channelInstructions,
        log: () => Effect.void,
      });
      stdio.send(initialize);
      yield* Effect.promise(async () =>
        until(() => stdio.lines.length > 0, "a response"),
      );
    });
    await Effect.runPromise(
      program.pipe(Effect.scoped, Effect.provide(stdio.layer)),
    );
    const result = stdio.lines[0]?.result as {
      protocolVersion: string;
      capabilities: { experimental: Record<string, unknown> };
    };
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities.experimental).toEqual({ "claude/channel": {} });
    expect(JSON.stringify(stdio.lines[0])).not.toContain(
      "claude/channel/permission",
    );
  });

  it("refuses to deliver before the session initialized, then writes one notification", async () => {
    const stdio = session();
    const program = Effect.gen(function* () {
      const channel = yield* ChannelServer.make({
        name: "slack",
        version: "0.0.0",
        instructions: channelInstructions,
        log: () => Effect.void,
      });
      const early = yield* Effect.result(channel.notify("hi", { ts: "1.2" }));
      expect(early._tag).toBe("Failure");
      stdio.send(initialized);
      yield* Deferred.await(channel.initialized);
      yield* channel.notify("hi", { ts: "1.2" });
    });
    await Effect.runPromise(
      program.pipe(Effect.scoped, Effect.provide(stdio.layer)),
    );
    expect(stdio.lines.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "notifications/claude/channel",
      params: { content: "hi", meta: { ts: "1.2" } },
    });
  });
});

describe("configuration", () => {
  const base = {
    channel: "C0WATCH001",
    ownPeople: ["U0OWN0001"],
    otherPeople: ["U0OTHER01"],
    tokens: {
      bot: "op://Private/slack-listener/bot_token",
      app: "op://Private/slack-listener/app_token",
    },
  };

  it("reads sides and token references", () => {
    const config = parseConfig(JSON.stringify(base), "test.json");
    expect(config.core.ownPeople).toEqual(["U0OWN0001"]);
    expect(config.core.otherPeople).toEqual(["U0OTHER01"]);
    expect(config.stateFile).toMatch(/C0WATCH001\.state\.json$/);
  });

  it("R6: refuses a literal token where a 1Password reference belongs", () => {
    const literal = {
      ...base,
      tokens: { bot: `xoxb-${"1".repeat(12)}`, app: base.tokens.app },
    };
    expect(() => parseConfig(JSON.stringify(literal), "test.json")).toThrow(
      ConfigError,
    );
  });
});

describe("R6: tokens stay secret", () => {
  it("redacts bot, user and app tokens from any log line", () => {
    const line = `failed with xoxb-${"1".repeat(10)}-abc and xapp-1-${"A".repeat(8)} and xoxp-${"2".repeat(6)}`;
    expect(redact(line)).toBe("failed with [token] and [token] and [token]");
  });
});

describe("configuration sides", () => {
  it("R10: refuses an id configured on both sides", () => {
    const both = {
      channel: "C0WATCH001",
      ownPeople: ["U0SHARED1"],
      otherPeople: ["U0SHARED1"],
      tokens: {
        bot: "op://vault/item/bot_token",
        app: "op://vault/item/app_token",
      },
    };
    expect(() => parseConfig(JSON.stringify(both), "test.json")).toThrow(
      /both sides/,
    );
  });
});

// A scripted Slack under the real HttpClient and Socket: the fetch function
// and the WebSocket constructor are the only things replaced, as the
// simulator will replace them (PRINCIPLES.md: simulator-runs-the-program).
class FakeSocket implements Socket.WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<
    string,
    Set<(event: Socket.WebSocketEvent) => void>
  >();

  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: Socket.WebSocketEvent) => void,
  ): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: Socket.WebSocketEvent) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: string, event: object): void {
    for (const listener of [...(this.listeners.get(type) ?? [])])
      listener(event as Socket.WebSocketEvent);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  frame(frame: object): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code, reason: "" });
  }

  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === "string" ? data : decoder.decode(data));
  }
}

const slackBodies: Record<string, object> = {
  "apps.connections.open": { ok: true, url: "wss://fake.invalid/link" },
  "conversations.history": { ok: true, messages: [] },
  "conversations.replies": { ok: true, messages: [] },
  "users.info": { ok: true, user: { name: "other-person" } },
  "auth.test": { ok: true, url: "https://fake.invalid/" },
};

const testConfig: ListenerConfig = {
  core: {
    channel: "C0WATCH001",
    ownPeople: ["U0OWN0001"],
    otherPeople: ["U0OTHER01"],
    ownBots: [],
    otherBots: [],
    ...defaultLimits,
    holdMs: 20,
    maxBackoffMs: 20,
  },
  channelName: "watch",
  serverName: "slack-listener",
  botTokenRef: "op://vault/item/bot_token",
  appTokenRef: "op://vault/item/app_token",
  stateFile: "/state/C0WATCH001.state.json",
  lockFile: "/state/C0WATCH001.lock",
  recordFile: null,
};

// Starts the whole shell on the test's stdio, a scripted fetch, the given
// WebSocket constructor and an in-memory disk.
function startShell(webSocket: (url: string) => Socket.WebSocketLike) {
  const stdio = session();
  const calls: string[] = [];
  const files = new Map<string, string>();
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = url.pathname.split("/").at(-1) ?? "";
    calls.push(method);
    return new Response(JSON.stringify(slackBodies[method] ?? { ok: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  const fileSystem = FileSystem.layerNoop({
    makeDirectory: () => Effect.void,
    writeFileString: (path, data) =>
      Effect.sync(() => {
        files.set(path, data);
      }),
    rename: (from, to) =>
      Effect.sync(() => {
        files.set(to, files.get(from) ?? "");
        files.delete(from);
      }),
  });
  const program = Effect.gen(function* () {
    const log = yield* makeLog;
    const sink = yield* ChannelServer.make({
      name: "slack-listener",
      version: "0.0.0",
      instructions: channelInstructions,
      log,
    });
    const api = yield* SlackApi.make("xoxb-test", "xapp-test");
    yield* runShell(testConfig, { api, sink, log }, null);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        stdio.layer,
        fileSystem,
        FetchHttpClient.layer,
        Layer.succeed(Socket.WebSocketConstructor)(webSocket),
      ),
    ),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );
  const done = Effect.runPromise(Effect.exit(program));
  stdio.send(initialize);
  stdio.send(initialized);
  const notifications = () =>
    stdio.lines.filter(
      (line) => line.method === "notifications/claude/channel",
    );
  return { stdio, calls, files, done, notifications };
}

function envelope(id: string, event: object) {
  return { type: "events_api", envelope_id: id, payload: { event } };
}

describe("the shell as an Effect program", () => {
  it("connects, catches up, delivers once, acks, and reconnects when Slack asks", async () => {
    const sockets: FakeSocket[] = [];
    const shell = startShell(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      setTimeout(() => socket.open(), 1);
      return socket;
    });

    await until(() => sockets[0]?.readyState === 1, "the first socket");
    const first = sockets[0] as FakeSocket;
    first.frame({ type: "hello" });
    await until(
      () => shell.calls.includes("conversations.history"),
      "catch-up",
    );
    const ts = msToTs(Date.now());
    first.frame(
      envelope("E0001", {
        type: "message",
        channel: "C0WATCH001",
        user: "U0OTHER01",
        text: "hello from the other side",
        ts,
      }),
    );
    await until(() => shell.notifications().length === 1, "the delivery");
    expect(first.sent).toContain(JSON.stringify({ envelope_id: "E0001" }));
    expect(JSON.stringify(shell.notifications()[0])).toContain(ts);
    expect(shell.files.has(testConfig.stateFile)).toBe(true);

    // A reply quotes the parent the shell remembered when it delivered it,
    // without asking Slack for it.
    const repliesAsked = () =>
      shell.calls.filter((call) => call === "conversations.replies").length;
    const asked = repliesAsked();
    first.frame(
      envelope("E0002", {
        type: "message",
        channel: "C0WATCH001",
        user: "U0OTHER01",
        text: "a reply",
        ts: msToTs(Date.now() + 1),
        thread_ts: ts,
      }),
    );
    await until(() => shell.notifications().length === 2, "the reply");
    expect(JSON.stringify(shell.notifications()[1])).toContain(
      "hello from the other side",
    );
    expect(repliesAsked()).toBe(asked);

    first.frame({ type: "disconnect", reason: "refresh_requested" });
    await until(() => sockets[1]?.readyState === 1, "the second socket");
    expect(shell.stdio.stderr.join("")).toContain(
      "slack asked to reconnect: refresh_requested",
    );

    shell.stdio.close();
    const exit = await shell.done;
    expect(exit._tag).toBe("Success");
    expect(shell.notifications()).toHaveLength(2);
    expect(shell.stdio.stderr.join("")).toContain(
      "stopping: the session closed stdin",
    );
  });

  it("stops loudly when a fiber of the shell dies", async () => {
    const shell = startShell(() => {
      throw new Error("bad socket url");
    });
    const exit = await shell.done;
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("a fiber of the shell stopped");
  });

  it("fires only the latest timer of a name", async () => {
    const fired: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const timers = yield* FiberMap.make<TimerName>();
          const fire = (label: string) =>
            Effect.sync(() => {
              fired.push(label);
            });
          yield* replaceTimer(timers, "tick", 40, fire("first"));
          yield* replaceTimer(timers, "tick", 5, fire("second"));
          yield* Effect.sleep(80);
        }),
      ),
    );
    expect(fired).toEqual(["second"]);
  });
});
