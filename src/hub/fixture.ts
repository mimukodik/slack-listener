// The task hub as the agreement property and the simulator run it: its
// actions over a fresh store, the principals who call them and what each may
// do, and a clock the caller sets. The ids are placeholders.
import type { Clock } from "effect";
import { Effect, Layer } from "effect";

import {
  type AnyAction,
  Principals,
  type Principal,
  provideAction,
} from "../action/action.ts";
import type { Fixture } from "../action/agreement.ts";
import { inMemoryPolicy } from "../action/policy.ts";
import { hubActions, permissions } from "./actions.ts";
import { type Snapshot, sqliteStoreLayer, TaskStore } from "./store.ts";

// Two people and two agents who may do everything, a channel that may only
// read, and a user with no grant. "h-nobody" is a bearer no principal has.
export const hubPrincipals: Readonly<Record<string, Principal>> = {
  "h-ann": "slack-user-t0000-u0001",
  "h-ben": "slack-user-t0000-u0002",
  "h-agent1": "agent-a0001",
  "h-agent2": "agent-a0002",
  "h-chan": "slack-channel-c0001",
  "h-eve": "slack-user-t0000-u0009",
};

export const hubBearers = [
  "h-ann",
  "h-ben",
  "h-agent1",
  "h-agent2",
  "h-chan",
  "h-eve",
  "h-nobody",
  "",
] as const;

const everything = Object.values(permissions);

export const hubGrants = {
  "slack-user-t0000-u0001": everything,
  "slack-user-t0000-u0002": everything,
  "agent-a0001": everything,
  "agent-a0002": everything,
  "slack-channel-c0001": [permissions.get, permissions.events],
};

export const hubPlatformLayer = Layer.merge(
  Layer.succeed(Principals)({
    authenticate: (bearer) => hubPrincipals[bearer],
  }),
  inMemoryPolicy(hubGrants),
);

// The hub's actions with their store given, and the store's snapshot, over
// a store the caller provides.
export const hubActionsOver = Effect.gen(function* () {
  const store = yield* TaskStore;
  const services = yield* Effect.context<TaskStore>();
  const actions: ReadonlyArray<AnyAction> = hubActions.map((action) =>
    provideAction(action, services),
  );
  return { actions, snapshot: store.snapshot };
});

// A fresh in-memory store per run.
export const hubFixture: Fixture<Snapshot> = Effect.gen(function* () {
  const services = yield* Layer.build(sqliteStoreLayer(":memory:")).pipe(
    Effect.orDie,
  );
  return yield* hubActionsOver.pipe(Effect.provideContext(services));
});

// A clock whose time the caller sets; it sleeps on the clock beneath, so the
// simulator's delays still run on simulated time.
export function settableClock(beneath: Clock.Clock, now: () => number) {
  const nanos = () => BigInt(now()) * 1_000_000n;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: now,
    currentTimeMillis: Effect.sync(now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: () => beneath.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: beneath.monotonicTimeNanos,
    sleep: (duration) => beneath.sleep(duration),
  };
  return clock;
}
