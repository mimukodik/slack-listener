// The MCP side of the listener: a channel server on the session's stdio. It
// reads JSON-RPC lines from stdin and writes responses and channel
// notifications to stdout, through Effect's Stdio service, so the simulator
// can stand in for the session (world-through-services).
import { Data, Deferred, Effect, Semaphore, Stdio, Stream } from "effect";
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

export class ChannelServer {
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
  ) {
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
          capabilities: { experimental: { "claude/channel": {} } },
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
    return this.respond({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `method not found: ${request.method}` },
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
