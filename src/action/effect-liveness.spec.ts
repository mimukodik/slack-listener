// Liveness failures that the simulator's seeded yield budget reaches and
// Effect's default budget does not: an interrupt Effect 4.1.4 loses, shown
// with Effect alone, and a bare MCP server that stalls in memory and answers
// an empty 500 over HTTP, whose causes are not found. They are pinned here,
// so that a change that fixes any of them fails these tests and
// withFixedBudget (agreement.ts) can be reconsidered (DECISIONS.md,
// 2026-11-22).
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
import { withFixedBudget } from "./agreement.ts";

describe("Effect 4.1.4 loses an interrupt under a yield budget of one", () => {
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
  // evaluation yields at its first operation. The fiber's pending start task
  // then cancels that yield and runs the body: the interrupt is lost, and the
  // fiber waits on. It is detached, so no parent's end interrupts it again;
  // in the simulator a scope's close waited on such a fiber forever.
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

  it("loses the interrupt of a child that has not started yet", () => {
    expect(forkThenInterrupt(1)).toBeUndefined();
  });
});

// The second and third failures are not attributed. A bare MCP server with
// one tool of its own, and none of the contract's code, stalls in memory and
// answers an empty 500 over HTTP for some seeds under the seeded budget, and
// does neither under the fixed one; nothing here shows whether Effect or the
// simulator is the cause.
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

  it("leaves a ping unanswered for seed 216, and answers it under the fixed budget", async () => {
    expect(await outcome(216, pings)).toBe("stuck");
    expect(await outcome(216, withFixedBudget(pings))).toBe("done");
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

  it("answers an empty 500 over HTTP for seed 1333, and only 200s under the fixed budget", async () => {
    const statusesOf = async (fixed: boolean) => {
      const runtime = new SimRuntime(1333);
      const statuses: number[] = [];
      const program = calls(runtime, statuses);
      const { value, tripped } = await withTripwire(async () => {
        runtime.start(fixed ? withFixedBudget(program) : program);
        return runtime.run({ stepsMax: 1_000_000, timeMsMax: 3_600_000 }, host);
      });
      expect(tripped).toEqual([]);
      expect(value.kind).toBe("done");
      return statuses;
    };
    expect(await statusesOf(false)).toContain(500);
    expect(new Set(await statusesOf(true))).toEqual(new Set([200]));
  });
});
