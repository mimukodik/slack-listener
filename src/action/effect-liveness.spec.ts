// Liveness failures that the simulator's seeded yield budget reached in
// Effect 4.1.4 and patches/effect@4.1.4.patch fixes: an interrupt lost by a
// fiber not yet started, a write lost by RPC's protocol buffers, and an RPC
// client ended before its request registered. They stay here as regression
// tests, so dropping or outgrowing the patch shows at once.
import { describe, expect, it } from "bun:test";

import { Deferred, Effect, Layer, Scheduler, Schema } from "effect";
import type { Scope } from "effect";
import { McpProtocol, McpServer, McpTest, Tool, Toolkit } from "effect/ai";
import {
  HttpEffect,
  HttpRouter,
  HttpServer,
  type HttpServerRequest,
} from "effect/http";

import { host, withTripwire } from "../sim/host.ts";
import { SimRuntime } from "../sim/runtime.ts";

describe("an interrupt under a yield budget of one", () => {
  // A scheduler whose tasks run only when the test drains them, and whose
  // budget the test sets, as the simulator's turn budget is set.
  function manual() {
    const tasks: Array<() => void> = [];
    const state = { budget: 2048 };
    const dispatcher: Scheduler.SchedulerDispatcher = {
      scheduleTask: (task) => {
        tasks.push(task);
      },
      flush: () => {},
    };
    const scheduler: Scheduler.Scheduler = {
      executionMode: "async",
      shouldYield: (fiber) => fiber.currentOpCount >= state.budget,
      makeDispatcher: () => dispatcher,
    };
    const drain = (): void => {
      for (let task = tasks.shift(); task !== undefined; task = tasks.shift())
        task();
    };
    return { scheduler, state, drain };
  }

  // A fiber forked but not yet started is interrupted; the interrupt's own
  // evaluation yields at its first operation. Unpatched, the fiber's pending
  // start task then cancelled that yield and ran the body: the interrupt was
  // lost, and a scope's close waited on the fiber forever.
  function forkThenInterrupt(budget: number) {
    const { scheduler, state, drain } = manual();
    const program = Effect.gen(function* () {
      const never = yield* Deferred.make<void>();
      const child = yield* Effect.forkDetach(Deferred.await(never));
      state.budget = budget;
      child.interruptUnsafe();
      state.budget = 2048;
      return child;
    });
    const parent = Effect.runFork(program, { scheduler });
    drain();
    const child = parent.pollUnsafe();
    if (child?._tag !== "Success") throw new Error("parent did not finish");
    drain();
    return child.value.pollUnsafe();
  }

  it("ends the interrupted child under the default budget", () => {
    const exit = forkThenInterrupt(2048);
    expect(exit?._tag).toBe("Failure");
  });

  it("ends a child interrupted before it started", () => {
    expect(forkThenInterrupt(1)?._tag).toBe("Failure");
  });
});

// A bare MCP server with one tool of its own and none of the contract's code.
// Unpatched, seed 216 stalled it in memory (a protocol write created before
// the reader was installed and run after it went to a buffer nobody replays)
// and seed 1333 got an empty 500 over HTTP (a request fiber that yielded
// before registering let the client's Eof end the response).
describe("a bare MCP server under the simulator's seeded budget", () => {
  const Noop = Tool.make("noop", {
    description: "Does nothing.",
    success: Schema.Boolean,
  });
  const tools = Toolkit.make(Noop);
  const registrations = McpServer.toolkit(tools).pipe(
    Layer.provide(tools.toLayer({ noop: () => Effect.succeed(true) })),
  );
  const pings = Effect.gen(function* () {
    for (let round = 0; round < 3; round++)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* McpTest.makeClient(registrations, {
            protocols: [McpProtocol.v2026_07_28],
          });
          yield* client.ping;
        }),
      );
  }).pipe(Effect.orDie);

  async function outcome(seed: number, program: Effect.Effect<void>) {
    const runtime = new SimRuntime(seed);
    const { value, tripped } = await withTripwire(async () => {
      runtime.start(program);
      return runtime.run({ stepsMax: 1_000_000, timeMsMax: 3_600_000 }, host);
    });
    expect(tripped).toEqual([]);
    return value.kind;
  }

  it("answers the ping for seed 216", async () => {
    expect(await outcome(216, pings)).toBe("done");
  });

  // The same server over Streamable HTTP, behind a web handler on the
  // builder's context, answering after a seeded delay.
  const endpoint = McpServer.layerHttp({
    name: "bare",
    version: "0.0.1",
    path: "/mcp",
    protocols: [McpProtocol.v2026_07_28],
    registrations,
  });
  const request = (id: number) =>
    new Request("http://bare.invalid/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "noop",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "noop",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "test",
              version: "0.0.1",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
  const calls = (runtime: SimRuntime, statuses: number[]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        const handler = HttpEffect.toWebHandlerWith<
          never,
          HttpServerRequest.HttpServerRequest | Scope.Scope
        >(context)(
          yield* HttpRouter.toHttpEffect(
            endpoint.pipe(Layer.provide(HttpServer.layerServices)),
          ),
        );
        for (let id = 1; id <= 12; id++) {
          const response = yield* Effect.promise(
            async () =>
              new Promise<Response>((resolve) => {
                void handler(request(id)).then((answer) => {
                  runtime.at(runtime.choices.int(21), () => {
                    resolve(answer);
                  });
                });
              }),
          );
          statuses.push(response.status);
          yield* Effect.promise(async () => response.text());
        }
      }),
    ).pipe(Effect.orDie);

  it("answers only 200s over HTTP for seed 1333", async () => {
    const runtime = new SimRuntime(1333);
    const statuses: number[] = [];
    const { value, tripped } = await withTripwire(async () => {
      runtime.start(calls(runtime, statuses));
      return runtime.run({ stepsMax: 1_000_000, timeMsMax: 3_600_000 }, host);
    });
    expect(tripped).toEqual([]);
    expect(value.kind).toBe("done");
    expect(new Set(statuses)).toEqual(new Set([200]));
  });
});
