// The MCP projection: one Tool per action, generated from the definitions,
// in one Toolkit that McpServer serves. A tool's parameters are the action's
// input, its success the action's success, and its failure every error the
// contract allows the action, returned as a tool result (failureMode
// "return"): the error-mapping rule's MCP form (action.ts). A query is marked
// read-only.
//
// The caller travels as a bearer to the hub, which the MCP side supplies: the
// Authorization header on the HTTP transport, else the request's _meta
// field named below, which an in-process or stdio client sets per request.
// The Authentication middleware resolves it to a principal through
// Principals, the same service REST uses, and never refuses by itself:
// invoke does. Past the middleware only the principal travels.
import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";

import {
  type AnyAction,
  CurrentPrincipal,
  invokeDecoded,
  type Policy,
  Principals,
} from "./action.ts";

export const bearerMetaKey = "mimukodik.action/bearer";

const bearerPrefix = "Bearer ";

// The bearer of one MCP request, from where the transport put it.
export function bearerOf(
  headers: Readonly<Record<string, string | undefined>>,
  metadata: Readonly<Record<string, unknown>> | undefined,
): string {
  const authorization = headers["authorization"];
  if (authorization?.startsWith(bearerPrefix) === true)
    return authorization.slice(bearerPrefix.length);
  const fromMeta = metadata?.[bearerMetaKey];
  return typeof fromMeta === "string" ? fromMeta : "";
}

function toolOf(action: AnyAction<unknown>) {
  const [first, ...rest] = action.failure;
  if (first === undefined) throw new Error("action: no failure schemas");
  return Tool.make(action.name, {
    description: action.description,
    parameters: action.inputSchema,
    success: action.success,
    failure: Schema.Union([first, ...rest]),
    failureMode: "return",
    dependencies: [CurrentPrincipal],
  })
    .annotate(Tool.Readonly, action.kind === "query")
    .annotate(Tool.Destructive, false);
}

export function toolkitOf(actions: ReadonlyArray<AnyAction<unknown>>) {
  return Toolkit.make(...actions.map(toolOf));
}

export type ActionToolkit = ReturnType<typeof toolkitOf>;

export const Authentication = McpServer.middleware<{
  provides: CurrentPrincipal;
}>()(
  Effect.gen(function* () {
    const principals = yield* Principals;
    return (effect, { headers, requestContext }) =>
      Effect.provideService(effect, CurrentPrincipal, {
        principal: principals.authenticate(
          bearerOf(headers, requestContext.requestMetadata),
        ),
      });
  }),
);

// The registrations for these actions: the toolkit, its handlers through
// invoke, and Authentication around every call.
export function registrationsOf<R>(
  toolkit: ActionToolkit,
  actions: ReadonlyArray<AnyAction<R>>,
) {
  return McpServer.toolkit(toolkit).pipe(
    Layer.provide(Authentication.layer),
    Layer.provide(
      toolkit.toLayer(
        // The Policy and the actions' own services (R) come from where the
        // layer is built, since a tool handler may only ask for its declared
        // dependencies; each handler runs on that context, not the
        // request's (invokeDecoded).
        Effect.gen(function* () {
          const services = yield* Effect.context<R | Policy>();
          return Object.fromEntries(
            actions.map((action) => [
              action.name,
              (params: unknown) =>
                Effect.gen(function* () {
                  const { principal } = yield* CurrentPrincipal;
                  return yield* invokeDecoded(
                    action,
                    principal,
                    params,
                    services,
                  );
                }),
            ]),
          );
        }),
      ),
    ),
  );
}
