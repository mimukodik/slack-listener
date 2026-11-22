import { describe, expect, it } from "bun:test";

import {
  Cause,
  Deferred,
  Duration,
  Effect,
  FiberMap,
  FileSystem,
  Layer,
  Queue,
  Schedule,
  Sink,
  Stdio,
  Stream,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { Socket } from "effect/socket";

import { ConfigError, parseConfig, type ListenerConfig } from "./config.ts";
import { defaultLimits, type TimerName } from "./core.ts";
import { channelInstructions } from "./format.ts";
import { makeLog } from "./log.ts";
import { ChannelServer } from "./mcp.ts";
import {
  backoffSchedule,
  decodeFrame,
  readSaved,
  replaceTimer,
  runShell,
} from "./shell.ts";
import { host, withTripwire } from "./sim/host.ts";
import { SimRuntime } from "./sim/runtime.ts";
import { simStartMs } from "./sim/simulator.ts";
import { redact, SlackApi } from "./slack-api.ts";
import { msToTs } from "./slack.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// The session's side of stdio: lines the test sends, lines the listener wrote.
function session(dieOnNotification = false) {
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
          if (
            dieOnNotification &&
            text.includes("notifications/claude/channel")
          )
            throw new Error("delivery fiber died at stdout");
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
  const sendLine = (line: string) =>
    Effect.runSync(Queue.offer(stdin, encoder.encode(`${line}\n`)));
  const send = (message: object) => sendLine(JSON.stringify(message));
  const close = () => Effect.runSync(Queue.end(stdin));
  return { layer, lines, stderr, send, sendLine, close };
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
      capabilities: {
        experimental: Record<string, unknown>;
        tools: Record<string, unknown>;
      };
    };
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities.experimental).toEqual({ "claude/channel": {} });
    expect(result.capabilities.tools).toEqual({});
    expect(JSON.stringify(stdio.lines[0])).not.toContain(
      "claude/channel/permission",
    );
  });

  it("R18: done takes a ts only, and answers once the listener decided", async () => {
    const stdio = session();
    const call = (id: number, name: string, args: object) =>
      stdio.send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      });
    const reply = (id: number) => stdio.lines.find((line) => line.id === id);
    const program = Effect.gen(function* () {
      const channel = yield* ChannelServer.make({
        name: "slack",
        version: "0.0.0",
        instructions: channelInstructions,
        log: () => Effect.void,
      });
      stdio.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      call(3, "done", { ts: "1795099386.438339\nforged line" });
      call(4, "post", { text: "hello" });
      call(5, "done", { ts: "1795099386.438339" });
      const mark = yield* Queue.take(channel.marks);
      expect(mark.ts).toBe("1795099386.438339");
      expect(reply(5)).toBeUndefined();
      yield* Deferred.succeed(mark.answer, false);
      call(6, "done", { ts: "1795099386.438340" });
      const second = yield* Queue.take(channel.marks);
      yield* Deferred.succeed(second.answer, true);
      yield* Effect.promise(async () =>
        until(() => reply(6) !== undefined, "the second done"),
      );
    });
    await Effect.runPromise(
      program.pipe(Effect.scoped, Effect.provide(stdio.layer)),
    );
    expect(JSON.stringify(reply(2))).toContain('"name":"done"');
    expect(reply(3)?.result).toMatchObject({ isError: true });
    expect(reply(4)?.error).toMatchObject({ code: -32602 });
    expect(reply(5)?.result).toMatchObject({ isError: true });
    expect(JSON.stringify(reply(5))).toContain("nothing changed");
    expect(reply(6)?.result).toMatchObject({ isError: false });
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

  // R22: a line that does not decode gets the JSON-RPC error the spec
  // names, and the server keeps reading.
  const answers = async (lines: readonly string[], lastId: number) => {
    const stdio = session();
    const logged: string[] = [];
    const program = Effect.gen(function* () {
      yield* ChannelServer.make({
        name: "slack",
        version: "0.0.0",
        instructions: channelInstructions,
        log: (line) => Effect.sync(() => void logged.push(line)),
      });
      for (const line of lines) stdio.sendLine(line);
      stdio.send({ jsonrpc: "2.0", id: lastId, method: "ping" });
      yield* Effect.promise(async () =>
        until(
          () => stdio.lines.some((line) => line.id === lastId),
          "the ping after the malformed lines",
        ),
      );
    });
    await Effect.runPromise(
      program.pipe(Effect.scoped, Effect.provide(stdio.layer)),
    );
    expect(stdio.lines.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: lastId,
      result: {},
    });
    expect(JSON.stringify(stdio.lines)).not.toContain("quoted words");
    expect(logged.join("\n")).not.toContain("quoted words");
    return stdio.lines
      .slice(0, -1)
      .map((line) => [
        line.id,
        (line.error as { code?: number } | undefined)?.code ?? "result",
      ]);
  };

  it("R22: answers a line that is not JSON with a parse error, and goes on", async () => {
    expect(await answers(["not json {", '{"quoted words'], 30)).toEqual([
      [null, -32700],
      [null, -32700],
    ]);
  });

  it("R22: answers a line that is not a request with an invalid request, and goes on", async () => {
    expect(
      await answers(
        [
          "null",
          "5",
          '"quoted words"',
          "[]",
          '[{"jsonrpc":"2.0","id":31,"method":"ping"}]',
          '{"jsonrpc":"2.0","id":32}',
          '{"jsonrpc":"2.0","id":33,"method":5}',
          '{"id":34,"method":"ping"}',
          '{"jsonrpc":"1.0","id":35,"method":"ping"}',
          '{"jsonrpc":"2.0","id":{"a":"quoted words"},"method":"ping"}',
          '{"jsonrpc":"2.0","id":null,"method":"ping"}',
          '{"jsonrpc":"2.0","id":36,"method":"ping","params":"quoted words"}',
          '{"jsonrpc":"2.0","method":5}',
        ],
        37,
      ),
    ).toEqual([
      [null, -32600],
      [null, -32600],
      [null, -32600],
      [null, -32600],
      [null, -32600],
      [32, -32600],
      [33, -32600],
      [34, -32600],
      [35, -32600],
      [null, -32600],
      [null, -32600],
      [36, -32600],
      [null, -32600],
    ]);
  });

  it("R22: answers a tool call whose params do not decode with invalid params", async () => {
    const call = (id: number, params: unknown) =>
      JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params });
    expect(
      await answers(
        [
          call(40, undefined),
          call(41, { name: 5 }),
          call(42, { name: "done", arguments: "quoted words" }),
          call(43, { name: "done", arguments: ["1795099386.438339"] }),
        ],
        44,
      ),
    ).toEqual([
      [40, -32602],
      [41, -32602],
      [42, -32602],
      [43, -32602],
    ]);
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

  it("R18: defaults the seen mark to eyes and the handled one to heavy_check_mark", () => {
    const parse = (extra: object) =>
      parseConfig(JSON.stringify({ ...base, ...extra }), "test.json");
    expect(parse({})).toMatchObject({
      reaction: "eyes",
      handledReaction: "heavy_check_mark",
    });
    expect(parse({ handledReaction: "ballot_box_with_check" })).toMatchObject({
      handledReaction: "ballot_box_with_check",
    });
  });

  // The same name for both would add the handled mark and then take it off as
  // the seen one, leaving a handled message without a mark.
  it("R18: refuses one name for both marks, and a name that is not an emoji name", () => {
    const parse = (extra: object) => () =>
      parseConfig(JSON.stringify({ ...base, ...extra }), "test.json");
    expect(parse({ handledReaction: "eyes" })).toThrow(/must differ/);
    expect(
      parse({
        reaction: "white_check_mark",
        handledReaction: "white_check_mark",
      }),
    ).toThrow(/must differ/);
    expect(parse({ handledReaction: "two words" })).toThrow(ConfigError);
  });
});

describe("the state file", () => {
  // A file written before the handled mark queued only seen calls, without a
  // mark; reading one must not turn its removals into removals of the
  // handled mark (R18).
  it("reads a reaction queue written before the handled mark as seen calls", async () => {
    const before = {
      version: 1,
      caughtUpUntilMs: 1,
      floorMs: 1,
      claimed: {},
      queue: [],
      inflight: null,
      held: [],
      reactions: [
        { action: "add", ts: "1795099500.661959" },
        { action: "remove", ts: "1795099386.438339" },
      ],
      reacted: { "1795099500.661959": "1795099386.438339" },
      answered: {},
      marked: {},
    };
    const fileSystem = FileSystem.layerNoop({
      readFileString: () => Effect.succeed(JSON.stringify(before)),
    });
    const saved = await Effect.runPromise(
      readSaved("/state/old.json").pipe(Effect.provide(fileSystem)),
    );
    expect(saved?.reactions).toEqual([
      { action: "add", mark: "seen", ts: "1795099500.661959" },
      { action: "remove", mark: "seen", ts: "1795099386.438339" },
    ]);
    expect(saved?.handled).toEqual({});
  });
});

// R19: the state file is decoded once, where it is read. A file this listener
// could not have written stops it before it connects, naming the field and
// never the file's text; a file written before a field existed still reads.
describe("R19: the state file as read", () => {
  const delivery = {
    key: "m:1795099386.438339",
    kind: "message",
    channel: "C0WATCH001",
    ts: "1795099386.438339",
    threadTs: "1795099386.438339",
    isReply: false,
    user: "U0OTHER01",
    text: "quoted words",
    postedAtMs: 1_795_099_386_438,
    editedAtMs: null,
    possibleDuplicate: false,
  };
  const written = {
    version: 1,
    caughtUpUntilMs: 1_795_099_000_000,
    floorMs: 1_795_098_000_000,
    claimed: { "m:1795099386.438339": 1_795_099_386_438 },
    queue: [delivery],
    inflight: { ...delivery, key: "m:1795099380.000100" },
    held: [
      {
        message: {
          type: "message",
          user: "U0OTHER01",
          text: "quoted words",
          ts: "1795099390.000100",
          edited: { user: "U0OTHER01", ts: "1795099391.000100" },
        },
        arrivedAtMs: 1_795_099_390_100,
      },
    ],
    reactions: [{ action: "add", mark: "handled", ts: "1795099386.438339" }],
    reacted: { "1795099386.438339": "1795099386.438339" },
    handled: { "1795099386.438339": 1_795_099_400_000 },
    answered: { "1795099386.438339": "1795099395.000100" },
    marked: { "1795099386.438339": 1_795_099_400_000 },
  };
  const read = async (text: string) =>
    Effect.runPromise(
      Effect.result(
        readSaved("/state/test.json").pipe(
          Effect.provide(
            FileSystem.layerNoop({
              readFileString: () => Effect.succeed(text),
            }),
          ),
        ),
      ),
    );
  const refused = async (text: string) => {
    const result = await read(text);
    if (result._tag === "Success")
      throw new Error(`read a file it should refuse: ${text.slice(0, 80)}`);
    expect(result.failure._tag).toBe("StateFileError");
    expect(result.failure.reason).toContain("/state/test.json");
    expect(result.failure.reason).not.toContain("quoted words");
    return result.failure.reason;
  };
  const without = (key: string) =>
    Object.fromEntries(Object.entries(written).filter(([k]) => k !== key));

  it("reads a file as this listener writes it", async () => {
    const result = await read(JSON.stringify(written));
    expect(result._tag === "Success" ? result.success : result).toEqual(
      written as never,
    );
  });

  it("reads a file written before R18 with R18's fields empty", async () => {
    const before = {
      version: 1,
      caughtUpUntilMs: written.caughtUpUntilMs,
      floorMs: written.floorMs,
      claimed: written.claimed,
      queue: written.queue,
      inflight: null,
      held: written.held,
    };
    const result = await read(JSON.stringify(before));
    expect(result._tag === "Success" ? result.success : result).toEqual({
      ...before,
      reactions: [],
      reacted: {},
      handled: {},
      answered: {},
      marked: {},
    } as never);
  });

  it("refuses a file that is not JSON", async () => {
    expect(await refused('{"version":1, "quoted words')).toContain("not JSON");
  });

  it("refuses a file that is not an object, or has another version", async () => {
    for (const text of ["null", "[]", '"quoted words"', "5"])
      await refused(text);
    expect(await refused(JSON.stringify({ ...written, version: 2 }))).toContain(
      "version",
    );
  });

  // Today's reading turned a missing timestamp into NaN and filled a
  // missing or wrong field with whatever came; each is refused now.
  it("refuses a field that is missing or of the wrong type, naming the field", async () => {
    const cases: [string, object][] = [
      ["caughtUpUntilMs", without("caughtUpUntilMs")],
      ["floorMs", { ...written, floorMs: String(written.floorMs) }],
      ["claimed", without("claimed")],
      ["claimed", { ...written, claimed: { "m:1": "quoted words" } }],
      ["queue", without("queue")],
      ["queue", { ...written, queue: "quoted words" }],
      ["queue", { ...written, queue: null }],
      ["ts", { ...written, queue: [{ ...delivery, ts: 1795099386 }] }],
      ["kind", { ...written, queue: [{ ...delivery, kind: "quoted words" }] }],
      ["inflight", without("inflight")],
      ["text", { ...written, inflight: { ...delivery, text: undefined } }],
      ["held", without("held")],
      [
        "ts",
        {
          ...written,
          held: [{ message: { text: "quoted words" }, arrivedAtMs: 1 }],
        },
      ],
      [
        "mark",
        {
          ...written,
          reactions: [{ action: "add", mark: "quoted words", ts: "1.2" }],
        },
      ],
      ["reacted", { ...written, reacted: { "1.2": 5 } }],
      ["marked", { ...written, marked: null }],
    ];
    for (const [field, file] of cases)
      expect(await refused(JSON.stringify(file))).toContain(field);
  });

  // A map's key is text from the file, so the error shows the map's name
  // and a placeholder in its place, never the key.
  it("names a map whose entry does not decode without its key", async () => {
    for (const field of ["claimed", "reacted", "handled", "answered", "marked"])
      expect(
        await refused(
          JSON.stringify({ ...written, [field]: { "quoted words": "x" } }),
        ),
      ).toContain(`at ${field}.[key]:`);
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
    this.raw(JSON.stringify(frame));
  }

  raw(data: string): void {
    this.emit("message", { data });
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
  "reactions.add": { ok: true },
  "reactions.remove": { ok: true },
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
  reaction: "eyes",
  handledReaction: "heavy_check_mark",
};

// Starts the whole shell on the test's stdio, a scripted fetch, the given
// WebSocket constructor and an in-memory disk.
function startShell(
  webSocket: (url: string) => Socket.WebSocketLike,
  dieOnNotification = false,
) {
  const stdio = session(dieOnNotification);
  const calls: string[] = [];
  // R18: each reaction call as "method name", in order.
  const reactionCalls: string[] = [];
  const files = new Map<string, string>();
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = url.pathname.split("/").at(-1) ?? "";
    calls.push(method);
    if (method.startsWith("reactions.")) {
      const body = init?.body;
      const text =
        body instanceof Uint8Array
          ? new TextDecoder().decode(body)
          : typeof body === "string" || body instanceof URLSearchParams
            ? body.toString()
            : "";
      reactionCalls.push(
        `${method} ${new URLSearchParams(text).get("name") ?? ""}`,
      );
    }
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
  return { stdio, calls, reactionCalls, files, done, notifications };
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

    // R18: both deliveries get the seen mark; our agent's answer in the
    // thread trades both for the handled one, and is itself not delivered.
    await until(
      () => shell.calls.filter((call) => call === "reactions.add").length === 2,
      "the reactions",
    );
    first.frame(
      envelope("E0003", {
        type: "message",
        channel: "C0WATCH001",
        user: "U0OWN0001",
        app_id: "A0AGENT01",
        text: "our answer",
        ts: msToTs(Date.now() + 2),
        thread_ts: ts,
      }),
    );
    await until(
      () =>
        shell.calls.filter((call) => call === "reactions.remove").length === 2,
      "the reactions removed",
    );
    expect(shell.reactionCalls).toEqual([
      "reactions.add eyes",
      "reactions.add eyes",
      "reactions.add heavy_check_mark",
      "reactions.remove eyes",
      "reactions.add heavy_check_mark",
      "reactions.remove eyes",
    ]);

    // R18: the session's done trades the mark without an answer.
    const quiet = msToTs(Date.now() + 3);
    first.frame(
      envelope("E0004", {
        type: "message",
        channel: "C0WATCH001",
        user: "U0OTHER01",
        text: "no reply needed",
        ts: quiet,
      }),
    );
    await until(
      () => shell.calls.filter((call) => call === "reactions.add").length === 5,
      "the third reaction",
    );
    shell.stdio.send({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    shell.stdio.send({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "done", arguments: { ts: quiet } },
    });
    await until(
      () =>
        shell.calls.filter((call) => call === "reactions.remove").length === 3,
      "the reaction taken off by done",
    );
    expect(shell.reactionCalls.slice(6)).toEqual([
      "reactions.add eyes",
      "reactions.add heavy_check_mark",
      "reactions.remove eyes",
    ]);
    expect(JSON.stringify(shell.stdio.lines)).toContain('"name":"done"');
    await until(
      () => JSON.stringify(shell.stdio.lines).includes(`Marked ${quiet} done`),
      "the done reply",
    );

    first.frame({ type: "disconnect", reason: "refresh_requested" });
    await until(() => sockets[1]?.readyState === 1, "the second socket");
    expect(shell.stdio.stderr.join("")).toContain(
      "slack asked to reconnect: refresh_requested",
    );

    shell.stdio.close();
    const exit = await shell.done;
    expect(exit._tag).toBe("Success");
    expect(shell.notifications()).toHaveLength(3);
    expect(shell.stdio.stderr.join("")).toContain(
      "stopping: the session closed stdin",
    );
  });

  // R20: a frame that does not decode is logged without its contents and
  // dropped; one with an envelope id is acknowledged first, so Slack does
  // not send it again. The connection goes on either way.
  const malformedFrames = async (
    send: (socket: FakeSocket, nowTs: () => string) => void,
  ) => {
    const sockets: FakeSocket[] = [];
    const shell = startShell(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      setTimeout(() => socket.open(), 1);
      return socket;
    });
    await until(() => sockets[0]?.readyState === 1, "the socket");
    const socket = sockets[0] as FakeSocket;
    socket.frame({ type: "hello" });
    await until(
      () => shell.calls.includes("conversations.history"),
      "catch-up",
    );
    let offsetMs = 0;
    send(socket, () => msToTs(Date.now() + (offsetMs += 1)));
    const ts = msToTs(Date.now() + 100);
    socket.frame(
      envelope("EVALID", {
        type: "message",
        channel: "C0WATCH001",
        user: "U0OTHER01",
        text: "after the malformed frames",
        ts,
      }),
    );
    await until(() => shell.notifications().length === 1, "the delivery");
    // Past the 20 ms hold, so a held malformed message would have reached
    // the core by now.
    await new Promise((resolve) => setTimeout(resolve, 60));
    shell.stdio.close();
    const exit = await shell.done;
    expect(exit._tag).toBe("Success");
    expect(shell.notifications()).toHaveLength(1);
    expect(JSON.stringify(shell.notifications()[0])).toContain(ts);
    const stderr = shell.stdio.stderr.join("");
    expect(stderr).not.toContain("quoted words");
    expect(sockets).toHaveLength(1);
    return { acks: socket.sent, stderr };
  };

  it("R20: drops a frame that does not decode, and the connection goes on", async () => {
    const { acks, stderr } = await malformedFrames((socket) => {
      socket.raw("not json, quoted words");
      socket.raw("null");
      socket.raw('"quoted words"');
      socket.raw("[1]");
      socket.frame({ type: 5 });
      socket.frame({
        type: "events_api",
        envelope_id: 7,
        payload: { event: { text: "quoted words" } },
      });
    });
    expect(acks).toEqual([JSON.stringify({ envelope_id: "EVALID" })]);
    expect(stderr.split("does not decode").length - 1).toBe(5);
    expect(stderr).toContain("slack sent a frame that is not JSON");
  });

  it("R20: acknowledges an envelope whose event does not decode, and delivers nothing of it", async () => {
    const { acks, stderr } = await malformedFrames((socket, nowTs) => {
      const message = {
        type: "message",
        channel: "C0WATCH001",
        user: "U0OTHER01",
        text: "quoted words",
      };
      socket.frame(envelope("ENOTS", message));
      socket.frame(envelope("ETSTYPE", { ...message, ts: 1795099386 }));
      socket.frame(envelope("ETEXT", { ...message, text: 5, ts: nowTs() }));
      socket.frame(
        envelope("EEDIT", {
          type: "message",
          subtype: "message_changed",
          channel: "C0WATCH001",
          ts: nowTs(),
          message: { ...message, ts: nowTs(), edited: { user: "U0OTHER01" } },
        }),
      );
      socket.frame({
        type: "events_api",
        envelope_id: "EPAYLOAD",
        payload: "quoted words",
      });
      // Not a message: acknowledged and dropped, as before.
      socket.frame(
        envelope("EREACTION", { type: "reaction_added", reaction: "eyes" }),
      );
    });
    expect(acks).toEqual(
      [
        "ENOTS",
        "ETSTYPE",
        "ETEXT",
        "EEDIT",
        "EPAYLOAD",
        "EREACTION",
        "EVALID",
      ].map((id) => JSON.stringify({ envelope_id: id })),
    );
    for (const id of ["ENOTS", "ETSTYPE", "ETEXT", "EEDIT", "EPAYLOAD"])
      expect(stderr).toContain(`envelope ${id} that does not decode`);
    expect(stderr).not.toContain("EREACTION that does not decode");
  });

  // Slack closes the socket after a disconnect frame whatever its reason
  // says, so the listener reconnects as it did before decoding.
  // Slack's timestamps are digits, a dot and digits; anything else is not a
  // ts, wherever it sits in an event.
  it("R20: a message whose ts is not a Slack timestamp does not decode", () => {
    const event = (fields: object) =>
      JSON.stringify(
        envelope("ETS", {
          type: "message",
          user: "U0OTHER01",
          text: "quoted words",
          ts: "1795099386.438339",
          ...fields,
        }),
      );
    expect(decodeFrame(event({})).kind).toBe("envelope");
    expect(decodeFrame(event({}))).toMatchObject({ undecoded: null });
    for (const [field, fields] of [
      ["ts", { ts: "1795099386" }],
      ["ts", { ts: "1795099386.438339.1" }],
      ["ts", { ts: "quoted words" }],
      ["ts", { ts: " 1795099386.438339" }],
      ["ts", { ts: "1795099386.438339\n" }],
      ["thread_ts", { thread_ts: "1795099386." }],
      ["latest_reply", { latest_reply: ".438339" }],
      ["edited.ts", { edited: { user: "U0OTHER01", ts: "1795099386,438339" } }],
    ] as const) {
      const frame = decodeFrame(event(fields));
      expect(frame, JSON.stringify(fields)).toMatchObject({
        kind: "envelope",
        message: null,
      });
      expect(
        frame.kind === "envelope" ? frame.undecoded : null,
        JSON.stringify(fields),
      ).toContain(`at payload.event.${field}: Expected a string matching`);
    }
  });

  it("R20: a disconnect frame reconnects whatever its reason holds", () => {
    expect(
      decodeFrame('{"type":"disconnect","reason":"refresh_requested"}'),
    ).toEqual({ kind: "disconnect", reason: "refresh_requested" });
    expect(
      decodeFrame('{"type":"disconnect","reason":["quoted words"]}'),
    ).toEqual({ kind: "disconnect", reason: "no reason" });
  });

  it("stops loudly when a fiber of the shell dies", async () => {
    const shell = startShell(() => {
      throw new Error("bad socket url");
    });
    const exit = await shell.done;
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("a fiber of the shell stopped");
  });

  it("stops loudly when a delivery fiber dies while writing to the session", async () => {
    const socket = new FakeSocket();
    const shell = startShell(() => {
      setTimeout(() => socket.open(), 1);
      return socket;
    }, true);
    await until(() => socket.readyState === 1, "the socket");
    socket.frame({ type: "hello" });
    // A message older than the catch-up's start is left to catch-up, and
    // this fake history is empty; post it after the history read, as Slack
    // would show an older one there.
    await until(
      () => shell.calls.includes("conversations.history"),
      "catch-up",
    );
    socket.frame(
      envelope("EDEATH", {
        type: "message",
        channel: "C0WATCH001",
        user: "U0OTHER01",
        text: "delivery dies",
        ts: msToTs(Date.now()),
      }),
    );
    const exit = await shell.done;
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("a fiber of the shell stopped");
    expect(JSON.stringify(exit)).toContain("delivery fiber died at stdout");
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

// R21: a Web API answer is decoded where it arrives; one that does not
// decode is a failed call, never a defect and never a success.
describe("R21: a Web API answer that does not decode", () => {
  const callWith = async <A>(
    body: string,
    call: (api: SlackApi) => Effect.Effect<A, { reason: string }>,
  ) => {
    const fetch = (async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    return Effect.runPromise(
      Effect.result(
        SlackApi.make("xoxb-test", "xapp-test").pipe(
          Effect.flatMap(call),
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, fetch),
        ),
      ),
    );
  };
  const history = (api: SlackApi) => api.history("C0WATCH001", "1.000000");

  it("fails the call, naming the method and the field but no value", async () => {
    const cases: [
      string,
      (api: SlackApi) => Effect.Effect<unknown, { reason: string }>,
      string,
    ][] = [
      ["not json, quoted words", history, "conversations.history"],
      ["null", history, "conversations.history"],
      ['"quoted words"', history, "conversations.history"],
      ["{}", history, "ok"],
      ['{"ok":"quoted words"}', history, "ok"],
      ['{"ok":false,"error":5}', history, "error"],
      ['{"ok":true,"messages":"quoted words"}', history, "messages"],
      [
        '{"ok":true,"messages":[],"response_metadata":{"next_cursor":5}}',
        history,
        "next_cursor",
      ],
      ['{"ok":true,"url":5}', (api) => api.openConnection(), "url"],
      ['{"ok":true,"url":["quoted words"]}', (api) => api.teamUrl(), "url"],
      [
        '{"ok":true,"user":{"name":"quoted words","real_name":5}}',
        (api) => api.userName("U0OTHER01"),
        "real_name",
      ],
      [
        '{"ok":true,"messages":[{"ts":5,"text":"quoted words"}]}',
        (api) => api.parentMessage("C0WATCH001", "1.2"),
        "ts",
      ],
      [
        "null",
        (api) => api.addReaction("C0WATCH001", "1.2", "eyes"),
        "reactions.add",
      ],
      ["[]", (api) => api.canRead("C0WATCH001"), "conversations.history"],
    ];
    for (const [body, call, field] of cases) {
      const result = await callWith(body, call);
      if (result._tag === "Success")
        throw new Error(`a call succeeded on ${body}`);
      expect(result.failure.reason).toContain(field);
      expect(result.failure.reason).not.toContain("quoted words");
    }
  });

  it("still reads an answer that decodes, ignoring fields it does not use", async () => {
    const result = await callWith(
      JSON.stringify({
        ok: true,
        messages: [
          {
            type: "message",
            user: "U0OTHER01",
            text: "hello",
            ts: "1795099386.438339",
            blocks: [{ type: "rich_text" }],
            reply_count: 2,
          },
        ],
        has_more: false,
        response_metadata: { next_cursor: "" },
      }),
      history,
    );
    expect(result._tag === "Success" ? result.success : result).toEqual({
      messages: [
        {
          type: "message",
          user: "U0OTHER01",
          text: "hello",
          ts: "1795099386.438339",
          reply_count: 2,
        },
      ],
      threads: [],
      skipped: [],
    } as never);
  });
});

// The whole shell on the simulator's virtual clock, with a scripted Slack
// whose answers come at once, so the time between two calls is exactly the
// wait the shell chose (PRINCIPLES.md: effect-does-the-waiting).
function virtualShell(
  seed: number,
  slack: (method: string, params: URLSearchParams) => unknown,
  onSocket: (socket: FakeSocket, runtime: SimRuntime) => void,
  options: { initializedAtMs: number } = { initializedAtMs: 0 },
) {
  const runtime = new SimRuntime(seed, [], simStartMs, false);
  const stdio = session();
  // Each Web API call as "ms-since-start method timestamp".
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = url.pathname.split("/").at(-1) ?? "";
    const body = init?.body;
    const params = new URLSearchParams(
      body instanceof Uint8Array
        ? decoder.decode(body)
        : typeof body === "string" || body instanceof URLSearchParams
          ? body.toString()
          : "",
    );
    calls.push(
      `${runtime.nowMs - simStartMs} ${method}${params.has("timestamp") ? ` ${params.get("timestamp") ?? ""}` : ""}`,
    );
    return new Response(JSON.stringify(slack(method, params)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  const program = Effect.gen(function* () {
    const log = yield* makeLog;
    const sink = yield* ChannelServer.make({
      name: "slack-listener",
      version: "0.0.0",
      instructions: channelInstructions,
      log,
    });
    const api = yield* SlackApi.make("xoxb-test", "xapp-test");
    yield* runShell(
      { ...testConfig, core: { ...testConfig.core, ...defaultLimits } },
      { api, sink, log },
      null,
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        stdio.layer,
        FileSystem.layerNoop({
          makeDirectory: () => Effect.void,
          writeFileString: () => Effect.void,
          rename: () => Effect.void,
        }),
        FetchHttpClient.layer,
        Layer.succeed(Socket.WebSocketConstructor)(() => {
          const socket = new FakeSocket();
          onSocket(socket, runtime);
          return socket;
        }),
      ),
    ),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );
  const run = async (stopAtMs: number) => {
    const { value, tripped } = await withTripwire(async () => {
      runtime.start(program);
      runtime.at(0, () => stdio.send(initialize));
      runtime.at(options.initializedAtMs, () => stdio.send(initialized));
      runtime.at(stopAtMs, () => stdio.close());
      return runtime.run(
        { stepsMax: 200_000, timeMsMax: simStartMs + stopAtMs + 60_000 },
        host,
      );
    });
    expect(tripped).toEqual([]);
    expect(value.kind).toBe("done");
  };
  return { runtime, stdio, calls, run };
}

// The time between each call of a method and the one before it.
function gaps(calls: readonly string[], method: string): number[] {
  const times = calls
    .filter((call) => call.split(" ")[1] === method)
    .map((call) => Number(call.split(" ")[0]));
  return times.slice(1).map((at, i) => at - (times[i] ?? 0));
}

describe("retries on a virtual clock", () => {
  // The old computation capped the exponent at 16 so the doubling could not
  // overflow; the schedule's own doubling reaches Infinity after 1,024 tries,
  // about 17 hours of outage at 60 s, and must still give the cap.
  it("R8: the backoff stays at its cap long after the doubling overflows", async () => {
    const delays = await Effect.runPromise(
      Effect.gen(function* () {
        const next = yield* Schedule.toStep(backoffSchedule(60_000));
        const out: number[] = [];
        for (let i = 0; i < 2000; i += 1) {
          const [, delay] = yield* Effect.orDie(next(i * 60_000, undefined));
          out.push(Duration.toMillis(delay));
        }
        return out;
      }),
    );
    expect(delays.slice(0, 8)).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
    ]);
    expect(new Set(delays.slice(6))).toEqual(new Set([60000]));
  });

  // R8: 1 s doubling, capped at 60 s; going live starts the run over.
  it("R8: reconnects after 1, 2, 4 … 32 s, then every 60 s, and starts over once live", async () => {
    for (const seed of [1, 2, 3]) {
      let opens = 0;
      // The first nine opens fail, the tenth goes live, and its socket drops
      // 10 s later; the eleventh fails and the twelfth goes live again.
      const failing = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11]);
      const shell = virtualShell(
        seed,
        (method) => {
          if (method !== "apps.connections.open")
            return slackBodies[method] ?? { ok: false };
          opens += 1;
          return failing.has(opens)
            ? { ok: false, error: "internal_error" }
            : (slackBodies[method] ?? { ok: false });
        },
        (socket, runtime) => {
          const first = opens === 10;
          runtime.at(1, () => socket.open());
          runtime.at(2, () => socket.frame({ type: "hello" }));
          if (first) runtime.at(10_000, () => socket.close(1006));
        },
      );
      await shell.run(300_000);
      expect(gaps(shell.calls, "apps.connections.open")).toEqual([
        1000,
        2000,
        4000,
        8000,
        16000,
        32000,
        60000,
        60000,
        60000,
        // The tenth went live and its socket closed 10 s later; the wait
        // after that is 1 s again, not 60.
        10_000 + 1000,
        2000,
      ]);
      expect(shell.stdio.stderr.join("")).toContain(
        "slack connection connect_failed: apps.connections.open: internal_error",
      );
    }
  });

  // R8: a failed catch-up read waits on the connection's run too, so it
  // continues the wait a failed open started.
  it("R8: a failed catch-up continues the connection's run of waits", async () => {
    let opens = 0;
    let reads = 0;
    const shell = virtualShell(
      1,
      (method) => {
        if (method === "apps.connections.open") opens += 1;
        if (method === "conversations.history") reads += 1;
        if (method === "apps.connections.open" && opens === 1)
          return { ok: false, error: "internal_error" };
        if (method === "conversations.history" && reads <= 2)
          return { ok: false, error: "internal_error" };
        return slackBodies[method] ?? { ok: false };
      },
      (socket, runtime) => {
        runtime.at(1, () => socket.open());
        runtime.at(2, () => socket.frame({ type: "hello" }));
      },
    );
    await shell.run(60_000);
    expect(gaps(shell.calls, "apps.connections.open")).toEqual([1000]);
    expect(gaps(shell.calls, "conversations.history")).toEqual([2000, 4000]);
  });

  // R21: a catch-up read whose answer does not decode is a failed read, so
  // it waits on the connection's run like any other failed read.
  it("R21: a catch-up read that does not decode is tried again after 1 and 2 s", async () => {
    let reads = 0;
    const shell = virtualShell(
      1,
      (method) => {
        if (method === "conversations.history") reads += 1;
        if (method === "conversations.history" && reads === 1)
          return { ok: true, messages: "quoted words" };
        if (method === "conversations.history" && reads === 2) return null;
        return slackBodies[method] ?? { ok: false };
      },
      (socket, runtime) => {
        runtime.at(1, () => socket.open());
        runtime.at(2, () => socket.frame({ type: "hello" }));
      },
    );
    await shell.run(60_000);
    expect(gaps(shell.calls, "conversations.history")).toEqual([1000, 2000]);
    const stderr = shell.stdio.stderr.join("");
    expect(stderr.split("catch-up failed: conversations.history").length).toBe(
      3,
    );
    expect(stderr).not.toContain("quoted words");
  });

  // R21: one message in a catch-up page that does not decode is skipped and
  // logged; the rest of the page is read, catch-up ends and the listener
  // goes live. The reviewer's probe: a bot message with bot_id null.
  it("R21: a catch-up page skips a message that does not decode and reads the rest", async () => {
    const goodTs = msToTs(simStartMs + 1);
    const badTs = msToTs(simStartMs + 2);
    const shell = virtualShell(
      1,
      (method) =>
        method === "conversations.history"
          ? {
              ok: true,
              messages: [
                { type: "message", text: "quoted words" },
                {
                  type: "message",
                  user: "U0OTHER01",
                  text: "quoted words",
                  ts: badTs,
                  bot_id: null,
                },
                {
                  type: "message",
                  user: "U0OTHER01",
                  text: "read from history",
                  ts: goodTs,
                },
              ],
            }
          : (slackBodies[method] ?? { ok: false }),
      (socket, runtime) => {
        runtime.at(1, () => socket.open());
        runtime.at(2, () => socket.frame({ type: "hello" }));
        runtime.at(5000, () =>
          socket.frame(
            envelope("ELIVE", {
              type: "message",
              channel: "C0WATCH001",
              user: "U0OTHER01",
              text: "live after catch-up",
              ts: msToTs(runtime.nowMs),
            }),
          ),
        );
      },
    );
    await shell.run(60_000);
    expect(
      shell.calls.filter((call) => call.endsWith(" conversations.history")),
    ).toHaveLength(1);
    const delivered = shell.stdio.lines
      .filter((line) => line.method === "notifications/claude/channel")
      .map((line) => JSON.stringify(line));
    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toContain("read from history");
    expect(delivered[1]).toContain("live after catch-up");
    const stderr = shell.stdio.stderr.join("");
    expect(stderr).toContain(
      `catch-up skipped a message in conversations.history that does not decode at ts:`,
    );
    expect(stderr).toContain(
      `catch-up skipped message ${badTs} in conversations.history that does not decode at bot_id:`,
    );
    expect(stderr).not.toContain("quoted words");
  });

  it("R21: a thread's replies page skips a reply that does not decode and reads the rest", async () => {
    const parentTs = msToTs(simStartMs + 1);
    const badTs = msToTs(simStartMs + 2);
    const goodTs = msToTs(simStartMs + 3);
    const parent = {
      type: "message",
      user: "U0OTHER01",
      text: "a parent",
      ts: parentTs,
      thread_ts: parentTs,
      reply_count: 2,
      latest_reply: goodTs,
    };
    const shell = virtualShell(
      1,
      (method) =>
        method === "conversations.history"
          ? { ok: true, messages: [parent] }
          : method === "conversations.replies"
            ? {
                ok: true,
                messages: [
                  parent,
                  {
                    type: "message",
                    user: "U0OTHER01",
                    text: 5,
                    ts: badTs,
                    thread_ts: parentTs,
                  },
                  {
                    type: "message",
                    user: "U0OTHER01",
                    text: "a good reply",
                    ts: goodTs,
                    thread_ts: parentTs,
                  },
                ],
              }
            : (slackBodies[method] ?? { ok: false }),
      (socket, runtime) => {
        runtime.at(1, () => socket.open());
        runtime.at(2, () => socket.frame({ type: "hello" }));
      },
    );
    await shell.run(60_000);
    const delivered = shell.stdio.lines
      .filter((line) => line.method === "notifications/claude/channel")
      .map((line) => JSON.stringify(line));
    expect(delivered.some((line) => line.includes("a good reply"))).toBe(true);
    expect(delivered.some((line) => line.includes(badTs))).toBe(false);
    expect(shell.stdio.stderr.join("")).toContain(
      `catch-up skipped message ${badTs} in conversations.replies that does not decode at text:`,
    );
  });

  // R21 with R7: a thread parent that does not decode is not delivered, but
  // its thread is still read, so a reply posted in the gap is delivered. The
  // reviewer's probe: a parent with bot_id null, one reply.
  it("R21: a thread parent that does not decode still has its replies read and delivered", async () => {
    const parentTs = msToTs(simStartMs + 1);
    const replyTs = msToTs(simStartMs + 2);
    const parent = {
      type: "message",
      user: "U0OTHER01",
      text: "quoted words",
      ts: parentTs,
      bot_id: null,
      thread_ts: parentTs,
      reply_count: 1,
      latest_reply: replyTs,
    };
    const shell = virtualShell(
      1,
      (method) =>
        method === "conversations.history"
          ? { ok: true, messages: [parent] }
          : method === "conversations.replies"
            ? {
                ok: true,
                messages: [
                  parent,
                  {
                    type: "message",
                    user: "U0OTHER01",
                    text: "a reply under an unreadable parent",
                    ts: replyTs,
                    thread_ts: parentTs,
                  },
                ],
              }
            : (slackBodies[method] ?? { ok: false }),
      (socket, runtime) => {
        runtime.at(1, () => socket.open());
        runtime.at(2, () => socket.frame({ type: "hello" }));
      },
    );
    await shell.run(60_000);
    expect(
      shell.calls.filter((call) => call.endsWith(" conversations.replies")),
    ).not.toHaveLength(0);
    const delivered = shell.stdio.lines
      .filter((line) => line.method === "notifications/claude/channel")
      .map((line) => JSON.stringify(line));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("a reply under an unreadable parent");
    expect(delivered[0]).toContain(replyTs);
    const stderr = shell.stdio.stderr.join("");
    expect(stderr).toContain(
      `catch-up skipped message ${parentTs} in conversations.history that does not decode at bot_id:`,
    );
    expect(stderr).not.toContain("quoted words");
  });

  // R21: an open whose answer does not decode is a failed open (R8).
  it("R21: an open that does not decode is tried again after 1 and 2 s", async () => {
    let opens = 0;
    const shell = virtualShell(
      1,
      (method) => {
        if (method === "apps.connections.open") opens += 1;
        if (method === "apps.connections.open" && opens <= 2)
          return { ok: true, url: opens === 1 ? 5 : null };
        return slackBodies[method] ?? { ok: false };
      },
      (socket, runtime) => {
        runtime.at(1, () => socket.open());
        runtime.at(2, () => socket.frame({ type: "hello" }));
      },
    );
    await shell.run(60_000);
    expect(gaps(shell.calls, "apps.connections.open")).toEqual([1000, 2000]);
  });

  // A delivery written while the session has not initialized fails and is
  // tried again on its own run of waits; its seen mark follows at once.
  it("a failed delivery is tried again after 1, 2 and 4 s", async () => {
    const shell = virtualShell(
      1,
      (method) => slackBodies[method] ?? { ok: false },
      (socket, runtime) => {
        runtime.at(1, () => socket.open());
        runtime.at(2, () => socket.frame({ type: "hello" }));
        runtime.at(1000, () =>
          socket.frame(
            envelope("E1", {
              type: "message",
              channel: "C0WATCH001",
              user: "U0OTHER01",
              text: "early",
              ts: msToTs(runtime.nowMs),
            }),
          ),
        );
      },
      // initialized comes after the first three tries.
      { initializedAtMs: 1000 + 3000 + 5000 },
    );
    await shell.run(60_000);
    const added = shell.calls.filter((call) => call.includes("reactions.add"));
    // Held 3 s, then tried at 4000, 5000, 7000 and written at 11000.
    expect(added.map((call) => Number(call.split(" ")[0]))).toEqual([11_000]);
    expect(
      shell.stdio.stderr.join("").split("delivery failed:").length - 1,
    ).toBe(3);
  });

  // R18: three tries at 0, 1 and 3 s, then given up; the next call goes on.
  describe("R18: a reaction call", () => {
    const deliverTwo = (
      first: (tried: number) => unknown,
    ): ReturnType<typeof virtualShell> => {
      const tries = new Map<string, number>();
      const shell = virtualShell(
        1,
        (method, params) => {
          const ts = params.get("timestamp") ?? "";
          if (method !== "reactions.add" || ts !== firstTs)
            return slackBodies[method] ?? { ok: false };
          const tried = (tries.get(ts) ?? 0) + 1;
          tries.set(ts, tried);
          return first(tried);
        },
        (socket, runtime) => {
          runtime.at(1, () => socket.open());
          runtime.at(2, () => socket.frame({ type: "hello" }));
          for (const [id, atMs] of [
            ["E1", 1000],
            ["E2", 1001],
          ] as const)
            runtime.at(atMs, () =>
              socket.frame(
                envelope(id, {
                  type: "message",
                  channel: "C0WATCH001",
                  user: "U0OTHER01",
                  text: id,
                  ts: msToTs(runtime.nowMs),
                }),
              ),
            );
        },
      );
      return shell;
    };
    // The first message arrives 1 s after the start, the second 1 ms later.
    const firstTs = msToTs(simStartMs + 1000);
    const secondTs = msToTs(simStartMs + 1001);
    const reactions = (calls: readonly string[]) =>
      calls
        .filter((call) => call.includes("reactions.add"))
        .map((call) => {
          const [at, , ts] = call.split(" ");
          return `${at} ${ts === firstTs ? "first" : ts === secondTs ? "second" : ts}`;
        });

    it("that keeps failing is tried at 0, 1 and 3 s, given up, and the next goes on", async () => {
      const shell = deliverTwo(() => ({ ok: false, error: "ratelimited" }));
      await shell.run(60_000);
      // Held 3 s from 1000, delivered and marked at 4000.
      expect(reactions(shell.calls)).toEqual([
        "4000 first",
        "5000 first",
        "7000 first",
        "7000 second",
      ]);
      expect(shell.stdio.stderr.join("")).toContain(
        `reaction add seen on ${firstTs} given up: ratelimited`,
      );
    });

    // R21: an answer that does not decode is a failed call.
    it("whose answer does not decode is tried at 0, 1 and 3 s and given up", async () => {
      const shell = deliverTwo((tried) =>
        tried === 1 ? null : tried === 2 ? "quoted words" : { ok: "yes" },
      );
      await shell.run(60_000);
      expect(reactions(shell.calls)).toEqual([
        "4000 first",
        "5000 first",
        "7000 first",
        "7000 second",
      ]);
      const stderr = shell.stdio.stderr.join("");
      expect(stderr).toContain(`reaction add seen on ${firstTs} given up:`);
      expect(stderr).not.toContain("quoted words");
    });

    it("that fails once is tried again after 1 s", async () => {
      const shell = deliverTwo((tried) =>
        tried === 1 ? { ok: false, error: "ratelimited" } : { ok: true },
      );
      await shell.run(60_000);
      expect(reactions(shell.calls)).toEqual([
        "4000 first",
        "5000 first",
        "5000 second",
      ]);
      expect(shell.stdio.stderr.join("")).not.toContain("given up");
    });

    // The shell tells the core a call was given up, so the core keeps the
    // seen mark when adding the handled one fails (marks-design-giveUp).
    it("adding the handled mark given up keeps the seen mark", async () => {
      const shell = virtualShell(
        1,
        (method, params) =>
          method === "reactions.add" &&
          params.get("name") === "heavy_check_mark"
            ? { ok: false, error: "ratelimited" }
            : (slackBodies[method] ?? { ok: false }),
        (socket, runtime) => {
          runtime.at(1, () => socket.open());
          runtime.at(2, () => socket.frame({ type: "hello" }));
          runtime.at(1000, () =>
            socket.frame(
              envelope("E1", {
                type: "message",
                channel: "C0WATCH001",
                user: "U0OTHER01",
                text: "E1",
                ts: msToTs(runtime.nowMs),
              }),
            ),
          );
          runtime.at(10_000, () =>
            socket.frame(
              envelope("E2", {
                type: "message",
                channel: "C0WATCH001",
                user: "U0OWN0001",
                app_id: "ACLAUDE01",
                text: "E2",
                thread_ts: firstTs,
                ts: msToTs(runtime.nowMs),
              }),
            ),
          );
        },
      );
      await shell.run(60_000);
      const onFirst = shell.calls
        .filter((call) => call.endsWith(` ${firstTs}`))
        .map((call) => call.split(" ").slice(0, 2).join(" "));
      // Seen at 4000; our agent's answer at 10000 is held 3 s, then the
      // handled mark is tried at 13000, 14000 and 16000 and given up, and
      // the seen mark is never removed.
      expect(onFirst).toEqual([
        "4000 reactions.add",
        "13000 reactions.add",
        "14000 reactions.add",
        "16000 reactions.add",
      ]);
      expect(shell.stdio.stderr.join("")).toContain(
        `reaction add handled on ${firstTs} given up: ratelimited`,
      );
    });

    it("answered as already done is not tried again", async () => {
      for (const error of [
        "already_reacted",
        "no_reaction",
        "message_not_found",
      ]) {
        const shell = deliverTwo(() => ({ ok: false, error }));
        await shell.run(60_000);
        expect(reactions(shell.calls)).toEqual(["4000 first", "4001 second"]);
        expect(shell.stdio.stderr.join("")).not.toContain("given up");
      }
    });
  });
});
