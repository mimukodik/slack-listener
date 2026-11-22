// The example that drives the contract: two actions over an in-memory store.
// getReceipt reads the caller's receipt for an event; acknowledge records
// one, idempotently per (caller, event). Storage is a later slice, so the
// store is a map behind one service, its only writer.
import { Context, Effect, Layer, Schema } from "effect";

import { type Caller, defineAction } from "./action.ts";

export const EventId = Schema.String.check(Schema.isPattern(/^E[0-9]{1,6}$/u));

export const Receipt = Schema.Struct({
  eventId: Schema.String,
  callerId: Schema.String,
  // The store's count of receipts when this one was recorded: an order that
  // needs no clock.
  number: Schema.Int,
});
export type Receipt = typeof Receipt.Type;

export class UnknownEvent extends Schema.TaggedError<UnknownEvent>()(
  "UnknownEvent",
  { message: Schema.String, eventId: Schema.String },
  { httpApiStatus: 404 },
) {}

// A snapshot of the store: the events it knows and every receipt, in the
// order recorded. Two stores agree when their snapshots are equal.
export type Snapshot = {
  readonly events: readonly string[];
  readonly receipts: readonly Receipt[];
};

export class ReceiptStore extends Context.Service<
  ReceiptStore,
  {
    readonly find: (
      eventId: string,
      callerId: string,
    ) => Effect.Effect<Receipt | null, UnknownEvent>;
    readonly record: (
      eventId: string,
      callerId: string,
    ) => Effect.Effect<Receipt, UnknownEvent>;
    readonly snapshot: Effect.Effect<Snapshot>;
  }
>()("action/ReceiptStore") {}

function key(eventId: string, callerId: string): string {
  return `${eventId}\u0000${callerId}`;
}

export function makeStore(events: readonly string[]): ReceiptStore["Service"] {
  const known = new Set(events);
  const receipts = new Map<string, Receipt>();
  const unknown = (eventId: string) =>
    new UnknownEvent({ message: `no event ${eventId}`, eventId });
  return {
    find: (eventId, callerId) =>
      known.has(eventId)
        ? Effect.succeed(receipts.get(key(eventId, callerId)) ?? null)
        : Effect.fail(unknown(eventId)),
    record: (eventId, callerId) =>
      Effect.suspend(() => {
        if (!known.has(eventId)) return Effect.fail(unknown(eventId));
        const existing = receipts.get(key(eventId, callerId));
        if (existing !== undefined) return Effect.succeed(existing);
        const receipt = { eventId, callerId, number: receipts.size + 1 };
        receipts.set(key(eventId, callerId), receipt);
        return Effect.succeed(receipt);
      }),
    snapshot: Effect.sync(() => ({
      events: [...known].sort(),
      receipts: [...receipts.values()],
    })),
  };
}

export const storeLayer = (store: ReceiptStore["Service"]) =>
  Layer.succeed(ReceiptStore)(store);

const canRead = (caller: Caller): boolean =>
  caller.role === "member" || caller.role === "reader";

export const getReceipt = defineAction({
  name: "getReceipt",
  description:
    "Reads the caller's receipt for an event: null if the caller has not acknowledged it.",
  kind: "query",
  input: { eventId: EventId },
  success: Schema.Struct({
    eventId: Schema.String,
    receipt: Schema.NullOr(Receipt),
  }),
  errors: [UnknownEvent],
  allow: (caller) => canRead(caller),
  handler: ({ eventId }, caller) =>
    Effect.gen(function* () {
      const store = yield* ReceiptStore;
      const receipt = yield* store.find(eventId, caller.id);
      return { eventId, receipt };
    }),
});

export const acknowledge = defineAction({
  name: "acknowledge",
  description:
    "Records that the caller has seen an event. A repeat returns the original receipt.",
  kind: "mutation",
  input: { eventId: EventId },
  success: Receipt,
  errors: [UnknownEvent],
  allow: (caller) => caller.role === "member",
  handler: ({ eventId }, caller) =>
    Effect.gen(function* () {
      const store = yield* ReceiptStore;
      return yield* store.record(eventId, caller.id);
    }),
});
