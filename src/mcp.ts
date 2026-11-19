// The MCP side of the listener: a channel server on the session's stdio. It
// reads JSON-RPC lines from stdin and writes responses and channel
// notifications to stdout, through Effect's Stdio service, so the simulator
// can stand in for the session (world-through-services).
import {
  Data,
  Deferred,
  Effect,
  Queue,
  Semaphore,
  Stdio,
  Stream,
} from "effect";
import type { Scope } from "effect";

export class SinkError extends Data.TaggedError("SinkError")<{
  reason: string;
}> {}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface ChannelServerOptions {
  name: string;
  version: string;
  instructions: string;
  log: (line: string) => Effect.Effect<void>;
}

// R18: the session marks a message done when it needs no reply, which turns
// the listener's reaction on it into the handled mark. The tool takes a ts and nothing else, so no
// text of the session's can reach Slack through it.
const doneTool = {
  name: "done",
  description:
    "Mark a Slack message from this channel as handled when it needs no reply. The listener then turns its reaction on the message into a check mark, which tells the sender you have dealt with it. Answering in the message's thread does the same, so you need this only when you do not answer.",
  inputSchema: {
    type: "object",
    properties: {
      ts: {
        type: "string",
        description:
          "The ts attribute of the message, for example 1795099386.438339",
      },
    },
    required: ["ts"],
    additionalProperties: false,
  },
} as const;

const slackTs = /^\d{10}\.\d{6}$/;

// A done call waiting for the listener: answer is done with whether the mark
// was taken, once it is saved, and only then does the session get its reply.
export interface Mark {
  readonly ts: string;
  readonly answer: Deferred.Deferred<boolean>;
}

export class ChannelServer {
  // Each message the session marked done, in order (R18).
  readonly marks: Queue.Queue<Mark>;
  // Done once the session sent notifications/initialized.
  readonly initialized: Deferred.Deferred<void>;
  // Done once stdin ended: the session is gone.
  readonly closed: Deferred.Deferred<void>;
  private readonly options: ChannelServerOptions;
  private readonly write: (message: object) => Effect.Effect<void, SinkError>;

  private constructor(
    options: ChannelServerOptions,
    write: (message: object) => Effect.Effect<void, SinkError>,
    initialized: Deferred.Deferred<void>,
    closed: Deferred.Deferred<void>,
    marks: Queue.Queue<Mark>,
  ) {
    this.marks = marks;
    this.options = options;
    this.write = write;
    this.initialized = initialized;
    this.closed = closed;
  }

  // Starts reading stdin in a fiber of the caller's scope. One write at a time
  // reaches stdout, so lines never interleave.
  static make(
    options: ChannelServerOptions,
  ): Effect.Effect<ChannelServer, never, Stdio.Stdio | Scope.Scope> {
    return Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio;
      const oneWriter = yield* Semaphore.make(1);
      const write = (message: object): Effect.Effect<void, SinkError> =>
        Stream.run(
          Stream.succeed(`${JSON.stringify(message)}\n`),
          stdio.stdout({ endOnDone: false }),
        ).pipe(
          Semaphore.withPermits(oneWriter, 1),
          Effect.mapError((error) => new SinkError({ reason: error.message })),
        );
      const server = new ChannelServer(
        options,
        write,
        yield* Deferred.make<void>(),
        yield* Deferred.make<void>(),
        yield* Queue.unbounded<Mark>(),
      );
      yield* stdio.stdin.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => server.onLine(line)),
        Effect.catch((error) =>
          options.log(`mcp: stdin failed: ${error.message}`),
        ),
        Effect.ensuring(Deferred.succeed(server.closed, undefined)),
        Effect.forkScoped,
      );
      return server;
    });
  }

  private respond(message: object): Effect.Effect<void> {
    return this.write(message).pipe(
      Effect.catch((error) =>
        this.options.log(`mcp: response not written: ${error.reason}`),
      ),
    );
  }

  private onLine(line: string): Effect.Effect<void> {
    if (line.trim() === "") return Effect.void;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return this.options.log("mcp: ignored a line that is not JSON");
    }
    if (request.method === "notifications/initialized")
      return Deferred.succeed(this.initialized, undefined).pipe(
        Effect.andThen(this.options.log("mcp: session initialized")),
      );
    if (request.id === undefined) return Effect.void;
    if (request.method === "initialize") {
      const requested = request.params?.protocolVersion;
      return this.respond({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion:
            typeof requested === "string" ? requested : "2025-06-18",
          capabilities: {
            experimental: { "claude/channel": {} },
            tools: {},
          },
          serverInfo: {
            name: this.options.name,
            version: this.options.version,
          },
          instructions: this.options.instructions,
        },
      });
    }
    if (request.method === "ping")
      return this.respond({ jsonrpc: "2.0", id: request.id, result: {} });
    if (request.method === "tools/list")
      return this.respond({
        jsonrpc: "2.0",
        id: request.id,
        result: { tools: [doneTool] },
      });
    if (request.method === "tools/call") return this.callTool(request);
    return this.respond({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `method not found: ${request.method}` },
    });
  }

  private callTool(request: JsonRpcRequest): Effect.Effect<void> {
    const id = request.id;
    const answer = (text: string, isError: boolean) =>
      this.respond({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text }], isError },
      });
    if (request.params?.name !== doneTool.name)
      return this.respond({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: `unknown tool: ${String(request.params?.name)}`,
        },
      });
    const args = request.params.arguments as { ts?: unknown } | undefined;
    const ts = args?.ts;
    if (typeof ts !== "string" || !slackTs.test(ts))
      return answer(
        "done needs the message's ts, such as 1795099386.438339.",
        true,
      );
    const marks = this.marks;
    return Effect.gen(function* () {
      const decided = yield* Deferred.make<boolean>();
      yield* Queue.offer(marks, { ts, answer: decided });
      const taken = yield* Deferred.await(decided);
      yield* taken
        ? answer(
            `Marked ${ts} done; the listener's reaction on it turns into a check mark.`,
            false,
          )
        : answer(
            `${ts} is not a message this listener handed you; nothing changed.`,
            true,
          );
    });
  }

  notify(
    content: string,
    meta: Record<string, string>,
  ): Effect.Effect<void, SinkError> {
    const notification = this.write({
      jsonrpc: "2.0",
      method: "notifications/claude/channel",
      params: { content, meta },
    });
    return Deferred.isDone(this.initialized).pipe(
      Effect.flatMap((ready) =>
        ready
          ? notification
          : Effect.fail(
              new SinkError({
                reason: "session has not initialized the channel yet",
              }),
            ),
      ),
    );
  }
}
