// The in-memory Policy: a fixed table of the permissions each principal
// holds. It stands in for iron-control's roles and grants, which can provide
// the same Policy service later without any action changing.
import { Effect, Layer } from "effect";

import { Policy, type Principal } from "./action.ts";

export type Grants = Readonly<Record<Principal, readonly string[]>>;

export function inMemoryPolicy(grants: Grants): Layer.Layer<Policy> {
  const table = new Map(
    Object.entries(grants).map(([principal, held]) => [
      principal,
      new Set(held),
    ]),
  );
  return Layer.succeed(Policy)({
    allows: (principal, permission) =>
      Effect.sync(() => table.get(principal)?.has(permission) === true),
  });
}
