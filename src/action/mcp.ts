// The MCP projection: one Tool per action, generated from the definitions,
// in one Toolkit that McpServer serves. A tool's parameters are the action's
// input, its success the action's success, and its failure every error the
// contract allows the action, returned as a tool result (failureMode
// "return"): the error-mapping rule's MCP form (action.ts). A query is marked
// read-only.
//
// The caller travels as a bearer to the hub in the Authorization header of
// MCP's HTTP transport, never in the JSON-RPC payload, where a log of the
// messages would keep it. The Authentication middleware resolves it to a
// principal through Principals, the same service REST uses, and never
// refuses by itself: invoke does. Past the middleware only the principal
// travels. Over stdio there is no header, so no principal: how a stdio
// session authenticates is open (DECISIONS.md, 2026-11-22).
import { Effect, Layer, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";

import {
  type AnyAction,
  CurrentPrincipal,
  invokeDecoded,
  surfaceServices,
  Principals,
} from "./action.ts";

export const mcpPath = "/mcp";

const bearerPrefix = "Bearer ";

// The bearer of one MCP request: the Authorization header, or none.
export function bearerOf(
  headers: Readonly<Record<string, string | undefined>>,
): string {
  const authorization = headers["authorization"];
  return authorization?.startsWith(bearerPrefix) === true
    ? authorization.slice(bearerPrefix.length)
    : "";
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
    return (effect, { headers }) =>
      Effect.provideService(effect, CurrentPrincipal, {
        principal: principals.authenticate(bearerOf(headers)),
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
          const services = yield* surfaceServices<R>("mcp");
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

// The MCP endpoint for these actions on an HttpRouter, beside the REST API:
// Streamable HTTP on the stateless 2026-07-28 protocol, so every call carries
// its own Authorization header.
export function mcpHttpLayer<R>(actions: ReadonlyArray<AnyAction<R>>) {
  return McpServer.layerHttp({
    name: "actions",
    version: "0.0.1",
    path: mcpPath,
    protocols: [McpProtocol.v2026_07_28],
    registrations: registrationsOf(toolkitOf(actions), actions),
  });
}
