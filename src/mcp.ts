import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { Data, Effect } from "effect";

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
  input: Readable;
  output: Writable;
  onClosed: () => void;
  log: (line: string) => void;
}

export class ChannelServer {
  private initialized = false;
  private readonly options: ChannelServerOptions;

  constructor(options: ChannelServerOptions) {
    this.options = options;
    const lines = createInterface({ input: options.input });
    lines.on("line", (line) => this.onLine(line));
    lines.on("close", () => options.onClosed());
  }

  get ready(): boolean {
    return this.initialized;
  }

  private async write(message: object): Promise<void> {
    return new Promise((resolve, reject) => {
      this.options.output.write(`${JSON.stringify(message)}\n`, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  private onLine(line: string): void {
    if (line.trim() === "") return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      this.options.log("mcp: ignored a line that is not JSON");
      return;
    }
    if (request.method === "notifications/initialized") {
      this.initialized = true;
      this.options.log("mcp: session initialized");
      return;
    }
    if (request.id === undefined) return;
    if (request.method === "initialize") {
      const requested = request.params?.protocolVersion;
      void this.write({
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
      return;
    }
    if (request.method === "ping") {
      void this.write({ jsonrpc: "2.0", id: request.id, result: {} });
      return;
    }
    void this.write({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `method not found: ${request.method}` },
    });
  }

  notify(
    content: string,
    meta: Record<string, string>,
  ): Effect.Effect<void, SinkError> {
    if (!this.initialized)
      return Effect.fail(
        new SinkError({
          reason: "session has not initialized the channel yet",
        }),
      );
    return Effect.tryPromise({
      try: async () =>
        this.write({
          jsonrpc: "2.0",
          method: "notifications/claude/channel",
          params: { content, meta },
        }),
      catch: (error) =>
        new SinkError({ reason: String((error as Error).message ?? error) }),
    });
  }
}
