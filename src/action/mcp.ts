// The MCP projection: one Tool per action, generated from the definitions,
// in one Toolkit that McpServer serves. A tool's parameters are the action's
// input, its success the action's success, and its failure every error the
// contract allows the action, returned as a tool result (failureMode
// "return"): the error-mapping rule's MCP form (action.ts). A query is marked
// read-only.
//
// The caller travels as a credential the MCP side supplies: the
// Authorization header on the HTTP transport, else the request's _meta
// field named below, which an in-process or stdio client sets per request.
// The Authentication middleware resolves it through Callers, the same
// service REST uses, and never refuses by itself: invoke does.
import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";

import {
  type AnyAction,
  Callers,
  CurrentCaller,
  invokeDecoded,
} from "./action.ts";

export const credentialMetaKey = "mimukodik.action/credential";

const bearerPrefix = "Bearer ";

// The credential of one MCP request, from where the transport put it.
export function credentialOf(
  headers: Readonly<Record<string, string | undefined>>,
  metadata: Readonly<Record<string, unknown>> | undefined,
): string {
  const authorization = headers["authorization"];
  if (authorization?.startsWith(bearerPrefix) === true)
    return authorization.slice(bearerPrefix.length);
  const fromMeta = metadata?.[credentialMetaKey];
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
    dependencies: [CurrentCaller],
  })
    .annotate(Tool.Readonly, action.kind === "query")
    .annotate(Tool.Destructive, false);
}

export function toolkitOf(actions: ReadonlyArray<AnyAction<unknown>>) {
  return Toolkit.make(...actions.map(toolOf));
}

export type ActionToolkit = ReturnType<typeof toolkitOf>;

export const Authentication = McpServer.middleware<{
  provides: CurrentCaller;
}>()(
  Effect.gen(function* () {
    const callers = yield* Callers;
    return (effect, { headers, requestContext }) =>
      Effect.provideService(effect, CurrentCaller, {
        caller: callers.authenticate(
          credentialOf(headers, requestContext.requestMetadata),
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
        // The actions' own services (R) come from where the layer is built,
        // since a tool handler may only ask for its declared dependencies.
        Effect.gen(function* () {
          const services = yield* Effect.context<R>();
          return Object.fromEntries(
            actions.map((action) => [
              action.name,
              (params: unknown) =>
                Effect.gen(function* () {
                  const { caller } = yield* CurrentCaller;
                  return yield* invokeDecoded(action, caller, params);
                }).pipe(Effect.provideContext(services)),
            ]),
          );
        }),
      ),
    ),
  );
}
