import { describe, expect, it } from "bun:test";

import { Cause, Context, Effect, Layer, Logger, Schema } from "effect";
import fc from "fast-check";

import { defineAction, type Policy, provideAction } from "./action.ts";
import {
  disagreement,
  runAgreement,
  runSimulated,
  runSequence,
} from "./agreement.ts";
import {
  type Call,
  platformLayer,
  bearers,
  makeWorld,
  principalsLayer,
  testGrants,
  surfaces,
} from "./harness.ts";
import { inMemoryPolicy } from "./policy.ts";
import { permissions } from "./receipts.ts";

// Inputs: known events, an unknown one, malformed ids, wrong types, a missing
// field and an extra one.
const input = fc.oneof(
  fc.constantFrom("E1", "E2", "E3").map((eventId) => ({ eventId })),
  fc.constant({ eventId: "E9" }),
  fc.constantFrom("", "bad", "e1", "E1234567", "E1 ").map((eventId) => ({
    eventId,
  })),
  fc.constantFrom(7, null, true).map((eventId) => ({ eventId })),
  fc.constant({}),
  fc.constant({ eventId: "E2", extra: "x" }),
);

const call: fc.Arbitrary<Call> = fc.record({
  action: fc.constantFrom("getReceipt", "acknowledge"),
  input,
  bearer: fc.constantFrom(...bearers),
  surface: fc.constantFrom(...surfaces),
});

const calls = fc.array(call, { minLength: 1, maxLength: 16 });

describe("the action contract", () => {
  it("every surface gives the same answers and leaves the same store", async () => {
    await fc.assert(
      fc.asyncProperty(calls, async (sequence) => {
        const agreement = await Effect.runPromise(
          runAgreement(sequence).pipe(Effect.provide(platformLayer)),
        );
        const difference = disagreement(sequence, agreement);
        if (difference !== undefined) throw new Error(difference);
      }),
      { numRuns: 150 },
    );
  }, 120_000);

  it("the surfaces agree under the simulator's seeded scheduler, with no real timer", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer(), calls, async (seed, sequence) => {
        const run = await runSimulated(seed, sequence);
        expect(run.tripped).toEqual([]);
        expect(run.outcome).toBe("done");
        if (run.agreement === undefined) throw new Error("no agreement");
        const difference = disagreement(sequence, run.agreement);
        if (difference !== undefined)
          throw new Error(`seed ${seed}: ${difference}`);
      }),
      { numRuns: 150 },
    );
  }, 120_000);

  it("a seed replays its run: the same trace, the same answers", async () => {
    const sequence = fc.sample(calls, { seed: 11, numRuns: 1 })[0] ?? [];
    for (const seed of [1, 2, 3]) {
      const first = await runSimulated(seed, sequence);
      const second = await runSimulated(seed, sequence);
      expect(first.outcome).toBe("done");
      expect(second.trace).toEqual(first.trace);
      expect(second.agreement).toEqual(first.agreement);
    }
    const one = await runSimulated(1, sequence);
    const two = await runSimulated(2, sequence);
    expect(two.trace).not.toEqual(one.trace);
    // The seed reaches the REST answers through the simulated clock.
    expect(one.trace.some((line) => line.includes(" timer "))).toBe(true);
  });

  it("a repeat acknowledge returns the original receipt on every surface", async () => {
    const twice: Call[] = surfaces.flatMap((surface) => [
      {
        action: "acknowledge",
        input: { eventId: "E1" },
        bearer: "t-alice",
        surface,
      },
    ]);
    const run = await Effect.runPromise(
      runSequence(twice, "chosen").pipe(Effect.provide(platformLayer)),
    );
    const values = run.observations.map((observation) =>
      observation.kind === "success" ? observation.value : observation,
    );
    expect(new Set(values.map((value) => JSON.stringify(value))).size).toBe(1);
    expect(run.snapshot.receipts).toHaveLength(1);
  });
});

describe("the policy", () => {
  it("decides by its Layer alone: another grant table, the same actions", async () => {
    const acknowledgeAsEve: Call[] = surfaces.map((surface) => ({
      action: "acknowledge",
      input: { eventId: "E1" },
      bearer: "t-eve",
      surface,
    }));
    const kinds = async (policy: Layer.Layer<Policy>) =>
      (
        await Effect.runPromise(
          runSequence(acknowledgeAsEve, "chosen").pipe(
            Effect.provide(Layer.merge(principalsLayer, policy)),
          ),
        )
      ).observations.map((observation) =>
        observation.kind === "failure" ? observation.error : observation.kind,
      );
    const refused = await kinds(inMemoryPolicy(testGrants));
    for (const each of refused)
      expect(each).toMatchObject({ _tag: "NotAllowed" });
    const granted = await kinds(
      inMemoryPolicy({
        ...testGrants,
        "slack-user-T0000-U0009": [permissions.acknowledge],
      }),
    );
    expect(granted).toEqual(surfaces.map(() => "success"));
  });
});

describe("an unexpected failure", () => {
  const secret = "secret-detail-7f3a";
  const explode = defineAction({
    name: "explode",
    description: "Dies with a message no surface may show.",
    kind: "mutation",
    input: { eventId: Schema.String },
    success: Schema.Struct({ ok: Schema.Boolean }),
    errors: [],
    permission: permissions.read,
    handler: () => Effect.die(new Error(secret)),
  });

  it("is a defect on every surface, leaks nothing, and reaches the server log", async () => {
    const logged: string[] = [];
    const serverLog = Logger.layer([
      Logger.make(({ cause }) => {
        logged.push(Cause.pretty(cause));
      }),
    ]);
    const program = Effect.scoped(
      Effect.gen(function* () {
        const world = yield* makeWorld([
          provideAction(explode, Context.empty()),
        ]);
        const observations = [];
        for (const surface of surfaces)
          observations.push(
            yield* world.call({
              action: "explode",
              input: { eventId: "E1" },
              bearer: "t-alice",
              surface,
            }),
          );
        const response = yield* Effect.promise(async () =>
          world.fetch(
            new Request("http://actions.invalid/explode", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: "Bearer t-alice",
              },
              body: JSON.stringify({ eventId: "E1" }),
            }),
          ),
        );
        const body = yield* Effect.promise(async () => response.text());
        return { observations, status: response.status, body };
      }),
    ).pipe(Effect.provide(Layer.merge(platformLayer, serverLog)));
    const result = await Effect.runPromise(program);
    expect(result.observations).toEqual(
      surfaces.map(() => ({ kind: "defect" })),
    );
    expect(result.status).toBe(500);
    expect(result.body).toBe("");
    expect(JSON.stringify(result.observations)).not.toContain(secret);
    // The operator sees it: McpServer logs a tool's defect on the server.
    expect(logged.some((line) => line.includes(secret))).toBe(true);
  });
});

// A service as text: its JSON where it has one.
function textOf(service: unknown): string {
  try {
    return JSON.stringify(service) ?? "";
  } catch {
    return String(service);
  }
}

describe("what a handler receives", () => {
  const bearer = "t-alice";
  const principal = "slack-user-T0000-U0001";
  const seen: Array<{
    readonly principal: string;
    readonly services: readonly string[];
    readonly leaks: readonly string[];
  }> = [];
  const inspect = defineAction({
    name: "inspect",
    description: "Reports what its handler can see.",
    kind: "mutation",
    input: { eventId: Schema.String },
    success: Schema.Struct({ ok: Schema.Boolean }),
    errors: [],
    permission: permissions.read,
    handler: (_input, who) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        const leaks: string[] = [];
        for (const [key, service] of context.mapUnsafe)
          if (textOf(service).includes(bearer)) leaks.push(key);
        seen.push({
          principal: who,
          services: [...context.mapUnsafe.keys()],
          leaks,
        });
        return { ok: true };
      }),
  });

  it("is the principal, and neither the bearer nor the transport's request", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const world = yield* makeWorld([
            provideAction(inspect, Context.empty()),
          ]);
          for (const surface of surfaces)
            yield* world.call({
              action: "inspect",
              input: { eventId: "E1" },
              bearer,
              surface,
            });
        }),
      ).pipe(Effect.provide(platformLayer)),
    );
    expect(seen).toHaveLength(surfaces.length);
    for (const each of seen) {
      expect(each.principal).toBe(principal);
      expect(each.leaks).toEqual([]);
      // The request each transport carries the bearer in.
      expect(each.services).not.toContain("effect/http/HttpServerRequest");
      expect(each.services).not.toContain(
        "effect/ai/McpSchema/McpRequestContext",
      );
      expect(each.services).not.toContain("action/CurrentPrincipal");
    }
  });
});
