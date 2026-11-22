// The atoms projection: AtomHttpApi query and mutation atoms over the REST
// projection's HttpApi, so a UI reads and writes through the same endpoints
// an outside REST client calls. A query action is a query atom, a mutation
// action a mutation atom; nothing is rendered here.
//
// The caller travels as the HTTP client's bearer to the hub: one atom client
// per bearer, whose client side of Authentication sets the bearer token on
// every request, as a signed-in UI does. A refusal comes back from the server
// and the client decodes it with the same error schema, so it is the atom's
// typed failure.
import { Layer } from "effect";
import { FetchHttpClient, HttpClientRequest } from "effect/http";
import { HttpApiMiddleware } from "effect/http-api";
import { AtomHttpApi } from "effect/reactivity";

import type { AnyAction, Fields, InputOf } from "./action.ts";
import { type Api, Authentication, groupName } from "./http.ts";

// The fetch the client sends with: the platform's in production, a function
// over the server's web handler in tests and the simulator.
export type Fetch = typeof globalThis.fetch;

export const baseUrl = "http://actions.invalid";

export function atomClientOf(
  api: Api,
  options: {
    readonly id: string;
    readonly bearer: string;
    readonly fetch: Fetch;
  },
) {
  const authentication = HttpApiMiddleware.layerClient(
    Authentication,
    ({ next, request }) =>
      next(HttpClientRequest.bearerToken(request, options.bearer)),
  );
  return AtomHttpApi.Service<unknown>()(options.id, {
    api,
    baseUrl,
    httpClient: Layer.mergeAll(
      authentication,
      FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(options.fetch)),
      ),
    ),
  });
}

export type AtomClient = ReturnType<typeof atomClientOf>;

// Every query atom of an API is invalidated by every mutation made through
// the same atom client: the generated default, coarse on purpose. A write
// made through another surface does not reach it (DECISIONS.md, 2026-11-22).
export const reactivityKeys = [groupName];

// The atom for one action and one input: a query atom for a query, so
// reading it runs the call; a mutation atom for a mutation, which runs when
// it is set with the input and reactivityKeys.
export function atomOf(
  client: AtomClient,
  action: AnyAction<unknown>,
  input: InputOf<Fields>,
) {
  return action.kind === "query"
    ? {
        kind: "query" as const,
        atom: client.query(groupName, action.name, {
          payload: input,
          reactivityKeys,
        }),
      }
    : {
        kind: "mutation" as const,
        atom: client.mutation(groupName, action.name),
      };
}
