// The REST projection: one HttpApi endpoint per action, generated from the
// definitions, and the handlers that run them through invoke. A query is a
// GET whose input travels in the query string; a mutation is a POST whose
// input is the JSON body. Each endpoint declares the action's success and
// every failure the contract allows it, with the status the error-mapping
// rule gives each one (action.ts).
//
// The caller travels as a bearer token to the hub. The Authentication
// middleware turns it into a CurrentPrincipal through Principals, the same
// service MCP uses, and never refuses by itself: invoke refuses a missing
// principal, the same way on every surface. Past the middleware only the
// principal travels.
import { type Context, Effect, Layer, Redacted } from "effect";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSecurity,
  OpenApi,
} from "effect/http-api";

import {
  type AnyAction,
  Principals,
  CurrentPrincipal,
  invokeDecoded,
  surfaceServices,
  type Policy,
} from "./action.ts";

export const groupName = "actions";

export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentPrincipal }
>()("action/Authentication", {
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
}) {}

export const pathOf = (action: AnyAction<unknown>): `/${string}` =>
  `/${action.name}`;

function endpointOf(action: AnyAction<unknown>) {
  const endpoint =
    action.kind === "query"
      ? HttpApiEndpoint.get(action.name, pathOf(action), {
          payload: action.input,
          success: action.success,
          error: action.failure,
        })
      : HttpApiEndpoint.post(action.name, pathOf(action), {
          payload: action.inputSchema,
          success: action.success,
          error: action.failure,
        });
  return endpoint.annotateMerge(
    OpenApi.annotations({ description: action.description }),
  );
}

export function apiOf(
  name: string,
  actions: ReadonlyArray<AnyAction<unknown>>,
) {
  const [first, ...rest] = actions.map(endpointOf);
  if (first === undefined) throw new Error("action: an API with no actions");
  return HttpApi.make(name).add(
    HttpApiGroup.make(groupName)
      .add(first, ...rest)
      .middleware(Authentication),
  );
}

export type Api = ReturnType<typeof apiOf>;

// The handler for one action: through invoke, with the principal the
// Authentication middleware resolved, on the context the handlers were built
// with, not the request's (invokeDecoded).
function handlerOf<R>(
  action: AnyAction<R>,
  services: Context.Context<R | Policy>,
) {
  return ({ payload }: { readonly payload: unknown }) =>
    Effect.gen(function* () {
      const { principal } = yield* CurrentPrincipal;
      return yield* invokeDecoded(action, principal, payload, services);
    });
}

// The handlers for every action of an API.
export function handlersOf<R>(api: Api, actions: ReadonlyArray<AnyAction<R>>) {
  return HttpApiBuilder.group(api, groupName, (handlers) =>
    Effect.gen(function* () {
      const services = yield* surfaceServices<R>("rest");
      return handlers.handleAll(
        Object.fromEntries(
          actions.map((action) => [action.name, handlerOf(action, services)]),
        ),
      );
    }),
  );
}

// The server side of Authentication: the bearer token, through Principals, to
// the principal for this request, or none.
export const authenticationLayer = Layer.effect(Authentication)(
  Effect.gen(function* () {
    const principals = yield* Principals;
    return Authentication.of({
      bearer: (httpEffect, { credential }) =>
        Effect.provideService(httpEffect, CurrentPrincipal, {
          principal: principals.authenticate(Redacted.value(credential)),
        }),
    });
  }),
);

// Everything a server needs for these actions, short of the platform
// services, Principals, the Policy and the actions' own requirements (R).
export function serverLayer<R>(api: Api, actions: ReadonlyArray<AnyAction<R>>) {
  return HttpApiBuilder.layer(api).pipe(
    Layer.provide(handlersOf(api, actions)),
    Layer.provide(authenticationLayer),
  );
}

export const openApiOf = (api: Api) => OpenApi.fromApi(api);
