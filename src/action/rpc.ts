// The RPC projection: one Rpc per action, generated from the definitions, in
// one RpcGroup that RpcServer serves over HTTP beside REST and MCP. An Rpc's
// payload is the action's input, its success the action's success, and its
// error every failure the contract allows the action, so an RPC client gets
// each declared error back as the same typed failure: the error-mapping
// rule's RPC form (action.ts). A defect crosses the wire as a fixed value
// with no message.
//
// The caller travels as a bearer to the hub in the Authorization header of
// the HTTP request that carries the RPC messages. The Authentication
// middleware reads it from that request, never from the headers inside the
// RPC message, which are part of the JSON body (and which RpcServer merges
// over the HTTP headers), and resolves it to a principal through Principals,
// the same service REST and MCP use. It never refuses by itself: invoke does.
// Past the middleware only the principal travels.
import { Effect, Layer, Option, Schema, SchemaTransformation } from "effect";
import { HttpServerRequest } from "effect/http";
import {
  Rpc,
  RpcGroup,
  RpcMiddleware,
  RpcSerialization,
  RpcServer,
} from "effect/rpc";

import {
  type AnyAction,
  CurrentPrincipal,
  invokeDecoded,
  Principals,
  surfaceServices,
} from "./action.ts";
import { bearerOf } from "./mcp.ts";

export const rpcPath = "/rpc";

// What a defect becomes on the wire: null, whatever the defect said, and a
// fixed error on the client. The server reports the defect itself.
export const internalError = "internal error";
const Defect = Schema.Null.pipe(
  Schema.decodeTo(
    Schema.Unknown,
    SchemaTransformation.transform<unknown, null>({
      decode: () => new Error(internalError),
      encode: () => null,
    }),
  ),
);

export class Authentication extends RpcMiddleware.Service<
  Authentication,
  { provides: CurrentPrincipal }
>()("action/RpcAuthentication") {}

function rpcOf(action: AnyAction<unknown>) {
  const [first, ...rest] = action.failure;
  if (first === undefined) throw new Error("action: no failure schemas");
  return Rpc.make(action.name, {
    payload: action.inputSchema,
    success: action.success,
    error: Schema.Union([first, ...rest]),
    defect: Defect,
  });
}

export function groupOf(actions: ReadonlyArray<AnyAction<unknown>>) {
  return RpcGroup.make(...actions.map(rpcOf)).middleware(Authentication);
}

export type ActionGroup = ReturnType<typeof groupOf>;

// The server side of Authentication: the Authorization header of the HTTP
// request, through Principals, to the principal for this call, or none. A
// transport with no HTTP request has no header, so no principal.
export const authenticationLayer = Layer.effect(Authentication)(
  Effect.gen(function* () {
    const principals = yield* Principals;
    return Authentication.of((effect) =>
      Effect.gen(function* () {
        const request = yield* Effect.serviceOption(
          HttpServerRequest.HttpServerRequest,
        );
        const bearer = Option.match(request, {
          onNone: () => "",
          onSome: ({ headers }) => bearerOf(headers),
        });
        return yield* Effect.provideService(effect, CurrentPrincipal, {
          principal: principals.authenticate(bearer),
        });
      }),
    );
  }),
);

// The handlers for every action of a group: through invoke, with the
// principal Authentication resolved, on the context the handlers were built
// with, not the request's (invokeDecoded).
export function handlersOf<R>(
  group: ActionGroup,
  actions: ReadonlyArray<AnyAction<R>>,
) {
  return group.toLayer(
    Effect.gen(function* () {
      const services = yield* surfaceServices<R>("rpc");
      return Object.fromEntries(
        actions.map((action) => [
          action.name,
          (payload: unknown) =>
            Effect.gen(function* () {
              const { principal } = yield* CurrentPrincipal;
              return yield* invokeDecoded(action, principal, payload, services);
            }),
        ]),
      );
    }),
  );
}

// The RPC endpoint for these actions on an HttpRouter: one POST route,
// request and response in one JSON body. A defect stays the call's own
// failure instead of ending every call of the client (disableFatalDefects).
export function rpcHttpLayer<R>(actions: ReadonlyArray<AnyAction<R>>) {
  const group = groupOf(actions);
  return RpcServer.layerHttp({
    group,
    path: rpcPath,
    protocol: "http",
    disableFatalDefects: true,
  }).pipe(
    Layer.provide(handlersOf(group, actions)),
    Layer.provide(authenticationLayer),
    Layer.provide(RpcSerialization.layerJson),
  );
}
