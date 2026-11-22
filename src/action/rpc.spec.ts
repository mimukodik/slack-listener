import { describe, expect, it } from "bun:test";

import {
  Cause,
  Context,
  Effect,
  ErrorReporter,
  Exit,
  Layer,
  Schema,
} from "effect";

import {
  defineAction,
  NotAllowed,
  provideAction,
  Unauthenticated,
} from "./action.ts";
import { makeWorld, platformLayer, rpcClientOf } from "./harness.ts";
import {
  acknowledge,
  getReceipt,
  makeStore,
  permissions,
  ReceiptStore,
  UnknownEvent,
} from "./receipts.ts";
import { groupOf, internalError, rpcPath } from "./rpc.ts";

const services = () => Context.make(ReceiptStore, makeStore(["E1"]));
const actionsOf = () => {
  const given = services();
  return [provideAction(getReceipt, given), provideAction(acknowledge, given)];
};

// One RPC request as the JSON serialization sends it, posted by hand.
const post = (
  httpHeaders: Record<string, string>,
  tag: string,
  payload: unknown,
  messageHeaders: ReadonlyArray<readonly [string, string]> = [],
) =>
  new Request(`http://actions.invalid${rpcPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...httpHeaders },
    body: JSON.stringify({
      _tag: "Request",
      id: "1",
      tag,
      payload,
      headers: messageHeaders,
    }),
  });

// The group's actions are erased, so a client is called by a name typed as a
// string, as the harness calls it.
const getReceiptName: string = getReceipt.name;
const explodeName: string = "explode";

describe("the RPC surface", () => {
  it("fails with the declared error itself, as the typed failure", async () => {
    const failures = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const actions = actionsOf();
          const world = yield* makeWorld(actions);
          const group = groupOf(actions);
          const failureOf = (bearer: string, eventId: string) =>
            Effect.gen(function* () {
              const client = yield* rpcClientOf(group, world.fetch, bearer);
              return yield* Effect.flip(
                Effect.asVoid(client(getReceiptName, { eventId })),
              );
            });
          return [
            yield* failureOf("t-alice", "E9"),
            yield* failureOf("", "E1"),
            yield* failureOf("t-eve", "E1"),
          ];
        }),
      ).pipe(Effect.provide(platformLayer)),
    );
    expect(failures[0]).toBeInstanceOf(UnknownEvent);
    expect(failures[0]).toMatchObject({ eventId: "E9" });
    expect(failures[1]).toBeInstanceOf(Unauthenticated);
    expect(failures[2]).toBeInstanceOf(NotAllowed);
    expect(failures[2]).toMatchObject({ permission: permissions.read });
  });

  it("takes the bearer from the Authorization header only, never from the RPC message", async () => {
    const texts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const world = yield* makeWorld(actionsOf());
          const answer = (request: Request) =>
            Effect.promise(async () => (await world.fetch(request)).text());
          return [
            yield* answer(
              post({}, "getReceipt", { eventId: "E1" }, [
                ["authorization", "Bearer t-alice"],
              ]),
            ),
            yield* answer(
              post(
                { authorization: "Bearer t-nobody" },
                "getReceipt",
                {
                  eventId: "E1",
                },
                [["authorization", "Bearer t-alice"]],
              ),
            ),
            yield* answer(
              post({ authorization: "Bearer t-alice" }, "getReceipt", {
                eventId: "E1",
              }),
            ),
          ];
        }),
      ).pipe(Effect.provide(platformLayer)),
    );
    expect(texts[0]).toContain("Unauthenticated");
    expect(texts[1]).toContain("Unauthenticated");
    expect(texts[2]).toContain('"receipt":null');
    expect(texts[2]).not.toContain("Unauthenticated");
  });

  it("sends a defect with no message, and the server reports it", async () => {
    const secret = "secret-detail-9c1e";
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
    // RpcServer reports a failed call to the ErrorReporters, not the log.
    const reported: string[] = [];
    const reporter = ErrorReporter.layer([
      ErrorReporter.make(({ cause }) => {
        reported.push(Cause.pretty(cause));
      }),
    ]);
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const actions = [provideAction(explode, Context.empty())];
          const world = yield* makeWorld(actions);
          const client = yield* rpcClientOf(
            groupOf(actions),
            world.fetch,
            "t-alice",
          );
          const exit = yield* Effect.exit(
            client(explodeName, { eventId: "E1" }),
          );
          const body = yield* Effect.promise(async () =>
            (
              await world.fetch(
                post({ authorization: "Bearer t-alice" }, "explode", {
                  eventId: "E1",
                }),
              )
            ).text(),
          );
          return { exit, body };
        }),
      ).pipe(Effect.provide(Layer.merge(platformLayer, reporter))),
    );
    expect(Exit.isFailure(result.exit)).toBe(true);
    if (Exit.isFailure(result.exit)) {
      expect(Cause.hasDies(result.exit.cause)).toBe(true);
      expect(Cause.pretty(result.exit.cause)).toContain(internalError);
      expect(Cause.pretty(result.exit.cause)).not.toContain(secret);
    }
    expect(result.body).not.toContain(secret);
    expect(result.body).toContain('"defect":null');
    expect(reported.some((line) => line.includes(secret))).toBe(true);
  });
});
