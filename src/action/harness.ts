// A world in which every surface of a set of actions answers in process: the
// REST server behind a fetch function, an MCP server behind McpTest's
// in-memory client, atom clients over that same fetch, and invoke called
// directly as the oracle. A call names its surface; every answer is reduced
// to one Observation, so the surfaces can be compared call by call.
//
// Everything runs on the services of the fiber that builds the world: its
// Scheduler, Clock and Random reach the REST requests (the web handler runs
// each request on the builder's context), the MCP server (built in the same
// scope) and the atom registry (its tasks go to the builder's Scheduler). In a
// plain test that is Effect's default runtime; under SimRuntime it is the
// seeded one, which is what lets the agreement run under the simulator.
import { Cause, Effect, Exit, Layer, Result, Scheduler, Schema } from "effect";
import type { Scope } from "effect";
import { McpProtocol, McpTest } from "effect/ai";
import {
  HttpEffect,
  HttpRouter,
  HttpServer,
  type HttpServerRequest,
} from "effect/http";
import { AtomRegistry } from "effect/reactivity";

import {
  type AnyAction,
  type Policy,
  type Principal,
  Principals,
  type ErrorSchema,
  type Fields,
  type InputOf,
  invokeDecoded,
} from "./action.ts";
import {
  type AtomClient,
  atomClientOf,
  atomOf,
  type Fetch,
  reactivityKeys,
} from "./atoms.ts";
import { apiOf, serverLayer } from "./http.ts";
import { bearerMetaKey, registrationsOf, toolkitOf } from "./mcp.ts";
import { inMemoryPolicy } from "./policy.ts";
import { permissions } from "./receipts.ts";

export const surfaces = ["rest", "mcp", "atom", "direct"] as const;
export type Surface = (typeof surfaces)[number];

// One answer, as every surface can report it. Values and errors are their
// JSON encodings, so a decoded atom answer and a raw REST body compare.
export type Observation =
  | { readonly kind: "success"; readonly value: unknown }
  | { readonly kind: "failure"; readonly error: unknown }
  | { readonly kind: "invalid" }
  | { readonly kind: "defect" };

export type Call = {
  readonly action: string;
  readonly input: InputOf<Fields>;
  // The bearer the client sends to the hub; empty for none at all.
  readonly bearer: string;
  readonly surface: Surface;
};

export type World = {
  readonly call: (call: Call) => Effect.Effect<Observation>;
  // The fetch over the REST server, for calls a test builds itself.
  readonly fetch: Fetch;
  // Requests that reached the REST server, from REST and atom calls.
  readonly requests: () => number;
};

// The principals of the example world, by bearer, named as iron-control
// names them: two Slack users who may read and acknowledge, a channel that
// may only read, and a user with no grant. "t-nobody" is a bearer no
// principal has. The ids are placeholders.
export const testPrincipals: Readonly<Record<string, Principal>> = {
  "t-alice": "slack-user-T0000-U0001",
  "t-carol": "slack-user-T0000-U0002",
  "t-bob": "slack-channel-C0001",
  "t-eve": "slack-user-T0000-U0009",
};

export const testGrants = {
  "slack-user-T0000-U0001": [permissions.read, permissions.acknowledge],
  "slack-user-T0000-U0002": [permissions.read, permissions.acknowledge],
  "slack-channel-C0001": [permissions.read],
};

export const bearers = [
  "t-alice",
  "t-carol",
  "t-bob",
  "t-eve",
  "t-nobody",
  "",
] as const;

// The platform a world runs on: who a bearer is, and what they may do.
export const principalsLayer = Layer.succeed(Principals)({
  authenticate: (bearer) => testPrincipals[bearer],
});

export const platformLayer = Layer.merge(
  principalsLayer,
  inMemoryPolicy(testGrants),
);

// The MCP tool text for a failure that is not a declared error.
const invalid: Observation = { kind: "invalid" };

const mcpInternalError =
  "Tool execution failed due to an internal server error.";
const mcpInvalidParams = "Invalid parameters for tool";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`harness: ${message}`);
}

// The status the error-mapping rule gives an error: the one it declares.
function statusOf(schema: ErrorSchema): number {
  const status = Schema.resolveAnnotations(schema)?.["httpApiStatus"];
  assert(typeof status === "number", `${schema.identifier} declares no status`);
  return status;
}

type Codecs = {
  readonly success: (value: unknown) => unknown;
  readonly failure: (error: unknown) => unknown;
  readonly decodeFailure: (
    encoded: unknown,
  ) => Result.Result<{ readonly _tag: string }, unknown>;
  readonly statusOf: (tag: string) => number;
};

function codecsOf(action: AnyAction<unknown>): Codecs {
  const [first, ...rest] = action.failure;
  assert(first !== undefined, "an action without failures");
  const failure = Schema.toCodecJson(Schema.Union([first, ...rest]));
  const statuses = new Map<string, number>(
    action.failure.map((schema: ErrorSchema) => [
      schema.identifier,
      statusOf(schema),
    ]),
  );
  const decodeFailure = Schema.decodeUnknownExit(failure);
  return {
    success: Schema.encodeUnknownSync(Schema.toCodecJson(action.success)),
    failure: Schema.encodeUnknownSync(failure),
    decodeFailure: (encoded) => {
      const exit = decodeFailure(encoded);
      return Exit.isSuccess(exit)
        ? Result.succeed(exit.value)
        : Result.fail(exit.cause);
    },
    statusOf: (tag) => {
      const status = statuses.get(tag);
      assert(status !== undefined, `no status for ${tag}`);
      return status;
    },
  };
}

function fromExit(
  codecs: Codecs,
  exit: Exit.Exit<unknown, unknown>,
  refusedBeforeSending: boolean,
): Observation {
  if (Exit.isSuccess(exit))
    return { kind: "success", value: codecs.success(exit.value) };
  const failure = Cause.findFail(exit.cause);
  if (Result.isSuccess(failure))
    return { kind: "failure", error: codecs.failure(failure.success.error) };
  const defect = Cause.findDefect(exit.cause);
  if (
    refusedBeforeSending &&
    Result.isSuccess(defect) &&
    Schema.isSchemaError(defect.success)
  )
    return { kind: "invalid" };
  return { kind: "defect" };
}

function parseJson(text: string): Result.Result<unknown, string> {
  try {
    const parsed: unknown = JSON.parse(text);
    return Result.succeed(parsed);
  } catch {
    return Result.fail(text);
  }
}

// A REST answer as an outside client sees it: the status and the body.
function fromRest(codecs: Codecs, status: number, body: string): Observation {
  if (status === 200) {
    const parsed = parseJson(body);
    assert(Result.isSuccess(parsed), "a 200 without a JSON body");
    return { kind: "success", value: parsed.success };
  }
  if (body === "") {
    if (status === 400) return { kind: "invalid" };
    assert(status === 500, `an empty ${status}`);
    return { kind: "defect" };
  }
  const parsed = parseJson(body);
  assert(Result.isSuccess(parsed), `a ${status} without a JSON body`);
  const error = codecs.decodeFailure(parsed.success);
  assert(Result.isSuccess(error), `a ${status} body that is no declared error`);
  // The error-mapping rule: the status is the one the error declares.
  assert(
    codecs.statusOf(error.success._tag) === status,
    `${error.success._tag} answered with ${status}`,
  );
  return { kind: "failure", error: parsed.success };
}

// An MCP tool result as an MCP client sees it.
function fromMcp(
  codecs: Codecs,
  result: {
    readonly isError?: boolean | undefined;
    readonly structuredContent?: unknown;
    readonly content: ReadonlyArray<{ readonly type: string }>;
  },
): Observation {
  if (result.isError !== true)
    return { kind: "success", value: result.structuredContent };
  const [first] = result.content;
  assert(
    first !== undefined && "text" in first && typeof first.text === "string",
    "a tool error without text",
  );
  const text = first.text;
  if (text === mcpInternalError) return { kind: "defect" };
  if (text.startsWith(mcpInvalidParams)) return { kind: "invalid" };
  const parsed = parseJson(text);
  assert(Result.isSuccess(parsed), "a tool error that is not JSON");
  const error = codecs.decodeFailure(parsed.success);
  assert(Result.isSuccess(error), "a tool error that is no declared error");
  return { kind: "failure", error: parsed.success };
}

function restRequest(action: AnyAction<unknown>, call: Call): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (call.bearer !== "") headers.set("authorization", `Bearer ${call.bearer}`);
  const url = new URL(`http://actions.invalid/${action.name}`);
  if (action.kind === "mutation")
    return new Request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(call.input),
    });
  // A query's input is its query string, one parameter per field, as the
  // OpenAPI document describes it.
  for (const [field, value] of Object.entries(call.input))
    url.searchParams.set(
      field,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  return new Request(url, { method: "GET", headers });
}

export type WorldOptions = {
  // When the REST server's answer reaches the client: at once by default; the
  // simulator passes a seeded delay on its own clock.
  readonly answer?: ((respond: () => void) => void) | undefined;
};

// Builds a world for these actions, their services already provided, in the
// current scope. Principals and the Policy come from the builder's context.
export function makeWorld(
  actions: ReadonlyArray<AnyAction>,
  options: WorldOptions = {},
) {
  const answer = options.answer ?? ((respond: () => void) => respond());
  return Effect.gen(function* () {
    const byName = new Map(actions.map((action) => [action.name, action]));
    const codecs = new Map(
      actions.map((action) => [action.name, codecsOf(action)]),
    );
    const builder = yield* Effect.context<Principals | Policy>();
    const principals = yield* Principals;

    // REST: the server's handler over the builder's context, behind fetch.
    const api = apiOf("actions", actions);
    const handlerEffect = yield* HttpRouter.toHttpEffect(
      serverLayer(api, actions).pipe(Layer.provide(HttpServer.layerServices)),
    );
    const handler = HttpEffect.toWebHandlerWith<
      Principals | Policy,
      HttpServerRequest.HttpServerRequest | Scope.Scope | Policy
    >(builder)(handlerEffect);
    let requests = 0;
    const fetch: Fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests += 1;
        const response = await handler(new Request(input, init));
        return new Promise<Response>((resolve) => {
          answer(() => resolve(response));
        });
      },
      {
        preconnect: (): void => {
          throw new Error("harness: fetch.preconnect");
        },
      },
    );

    // MCP: one in-memory client; the bearer travels per request.
    const mcp = yield* McpTest.makeClient(
      registrationsOf(toolkitOf(actions), actions),
      { protocols: [McpProtocol.v2026_07_28] },
      // The only failure is a protocol version the server lacks: a bug here.
    ).pipe(Effect.orDie);

    // Atoms: one client per bearer, one registry, whose tasks run on the
    // builder's scheduler.
    const scheduler = yield* Scheduler.Scheduler;
    const dispatcher = scheduler.makeDispatcher();
    const registry = AtomRegistry.make({
      scheduleTask: (task) => {
        dispatcher.scheduleTask(task, 0);
        return () => {};
      },
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
    const atomClients = new Map<string, AtomClient>();
    const atomClient = (bearer: string): AtomClient => {
      const existing = atomClients.get(bearer);
      if (existing !== undefined) return existing;
      const client = atomClientOf(api, {
        id: `action/atoms/${atomClients.size}`,
        bearer,
        fetch,
      });
      atomClients.set(bearer, client);
      return client;
    };

    const call = (input: Call): Effect.Effect<Observation> =>
      Effect.gen(function* () {
        const action = byName.get(input.action);
        const codec = codecs.get(input.action);
        assert(
          action !== undefined && codec !== undefined,
          `no action ${input.action}`,
        );
        switch (input.surface) {
          case "direct": {
            const decoded = Schema.decodeUnknownExit(action.inputSchema)(
              input.input,
            );
            if (Exit.isFailure(decoded)) return invalid;
            const principal = principals.authenticate(input.bearer);
            const exit = yield* Effect.exit(
              invokeDecoded(action, principal, decoded.value, builder),
            );
            return fromExit(codec, exit, false);
          }
          case "rest": {
            const response = yield* Effect.promise(async () =>
              fetch(restRequest(action, input)),
            );
            const body = yield* Effect.promise(async () => response.text());
            return fromRest(codec, response.status, body);
          }
          case "mcp": {
            const result = yield* mcp.callTool({
              name: action.name,
              arguments: input.input,
              _meta: { [bearerMetaKey]: input.bearer },
            });
            return fromMcp(codec, result);
          }
          case "atom": {
            const before = requests;
            const target = atomOf(
              atomClient(input.bearer),
              action,
              input.input,
            );
            // Mounted for the call, as a component mounts the atoms it uses,
            // so the registry keeps the atom, and its run, until the read.
            const unmount = registry.mount(target.atom);
            // A query is read afresh, as a mounted one is after a refresh.
            if (target.kind === "query") registry.refresh(target.atom);
            else
              registry.set(target.atom, {
                payload: input.input,
                reactivityKeys,
              });
            const exit = yield* Effect.exit(
              AtomRegistry.getResult(registry, target.atom, {
                suspendOnWaiting: true,
              }),
            ).pipe(Effect.ensuring(Effect.sync(unmount)));
            return fromExit(codec, exit, requests === before);
          }
        }
      }).pipe(Effect.orDie);

    return { call, fetch, requests: () => requests } satisfies World;
  });
}
