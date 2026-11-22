// The action contract: one definition per action, from which every surface
// (REST, MCP, atoms) is generated (DECISIONS.md, 2026-11-22: the action
// contract). An action is a name, a description, a Schema input and success
// value, its typed errors, the permission it needs, whether it reads or
// writes, and a handler. Nothing here knows about HTTP, MCP or atoms.
//
// Every surface reaches the handler through invoke, which holds the two
// refusals every action shares: no principal (Unauthenticated) and a
// principal the Policy does not grant the action's permission (NotAllowed).
// Each surface decodes the input with the action's own schema where the input
// enters (decode-at-the-boundary), so invoke receives a decoded input and a
// resolved principal, never raw data.
//
// No secret is part of the contract. The caller is a principal, an opaque id
// such as iron-control's "slack-user-<team>-<user>"; a handler receives that
// id and never a token. The bearer a client sends to the hub stops at the
// surface that resolves it, and an outbound call a handler makes goes through
// iron-proxy, which adds the credential on the wire.
import { Context, Effect, Schema } from "effect";

export type Kind = "query" | "mutation";

// A schema that needs no services to decode or encode: what an action's
// input fields, success and errors are, so every surface can run them as is.
export type Codec = Schema.Top & {
  readonly DecodingServices: never;
  readonly EncodingServices: never;
};

// An action's input: named fields, each a full Schema.
export type Fields = { readonly [field: string]: Codec };

// Who is calling: a principal, an opaque id the platform names. The contract
// never looks inside it.
export type Principal = string;

// Maps the bearer a client sends to the hub to the principal it stands for.
// Every surface resolves its bearer through this one service, so a bearer
// means the same principal everywhere. The bearer goes no further.
export class Principals extends Context.Service<
  Principals,
  { readonly authenticate: (bearer: string) => Principal | undefined }
>()("action/Principals") {}

// The principal a surface resolved for the current call, or none. Each
// surface provides it from its own transport (DECISIONS.md: how the caller
// travels).
export class CurrentPrincipal extends Context.Service<
  CurrentPrincipal,
  { readonly principal: Principal | undefined }
>()("action/CurrentPrincipal") {}

// Whether a principal holds a permission. A Layer provides it: an in-memory
// table in tests, iron-control's roles and grants later, with no action
// changing. It is an Effect so that an implementation may ask a service.
export class Policy extends Context.Service<
  Policy,
  {
    readonly allows: (
      principal: Principal,
      permission: string,
    ) => Effect.Effect<boolean>;
  }
>()("action/Policy") {}

// The error-mapping rule, in one place. Every typed error of an action is a
// Schema.TaggedError with a message field and an httpApiStatus annotation,
// as the two below are. From that one definition:
// - REST answers with the status and the error's JSON encoding as the body;
// - MCP answers with a tool result marked isError, whose one text content is
//   the same JSON encoding, so the tag and the message travel together;
// - atoms fail with the decoded error itself, a typed failure in AsyncResult.
// An unexpected failure (a defect) is not an action error: REST answers an
// empty 500, MCP a fixed internal-error text, atoms a defect; none of them
// carries the defect's message.
export const statusUnauthenticated = 401;
export const statusNotAllowed = 403;

export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  { message: Schema.String },
  { httpApiStatus: statusUnauthenticated },
) {}

export class NotAllowed extends Schema.TaggedError<NotAllowed>()(
  "NotAllowed",
  { message: Schema.String, action: Schema.String, permission: Schema.String },
  { httpApiStatus: statusNotAllowed },
) {}

// What an action's error schema must look like: a tagged error class whose
// encoding carries _tag and message.
export type ErrorSchema = Codec & {
  readonly identifier: string;
  readonly Type: { readonly _tag: string; readonly message: string };
};

export type Definition<
  Name extends string,
  Input extends Fields,
  Success extends Codec,
  Errors extends ErrorSchema,
  R,
> = {
  readonly name: Name;
  readonly description: string;
  readonly kind: Kind;
  // The input is always an object of named fields: MCP requires an object
  // root, and a query's fields become its query string.
  readonly input: Input;
  readonly success: Success;
  readonly errors: ReadonlyArray<Errors>;
  // The permission a principal needs to call the action, by name; the Policy
  // decides who holds it.
  readonly permission: string;
  // A method, so an action with a narrower input is still an AnyAction.
  handler(
    input: InputOf<Input>,
    principal: Principal,
  ): Effect.Effect<Success["Type"], Errors["Type"], R>;
};

export type InputOf<Input extends Fields> = Schema.Struct<Input>["Type"];

export type Action<
  Name extends string,
  Input extends Fields,
  Success extends Codec,
  Errors extends ErrorSchema,
  R,
> = Definition<Name, Input, Success, Errors, R> & {
  readonly inputSchema: Schema.Struct<Input>;
  // The action's errors and the two refusals every action shares; each
  // surface declares exactly these.
  readonly failure: ReadonlyArray<
    Errors | typeof Unauthenticated | typeof NotAllowed
  >;
};

// Every action, with its types erased, as the projections handle them.
export type AnyAction<R = never> = Action<
  string,
  Fields,
  Codec,
  ErrorSchema,
  R
>;

const namePattern = /^[a-z][A-Za-z0-9]{0,63}$/;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`action: ${message}`);
}

export function defineAction<
  const Name extends string,
  const Input extends Fields,
  Success extends Codec,
  Errors extends ErrorSchema,
  R,
>(
  definition: Definition<Name, Input, Success, Errors, R>,
): Action<Name, Input, Success, Errors, R> {
  assert(namePattern.test(definition.name), `bad name ${definition.name}`);
  assert(
    definition.description.length > 0,
    `${definition.name}: no description`,
  );
  assert(definition.permission.length > 0, `${definition.name}: no permission`);
  const tags = definition.errors.map((error) => error.identifier);
  assert(
    new Set(tags).size === tags.length,
    `${definition.name}: an error tag is declared twice`,
  );
  assert(
    !tags.includes("Unauthenticated") && !tags.includes("NotAllowed"),
    `${definition.name}: declares a refusal every action already has`,
  );
  return {
    ...definition,
    inputSchema: Schema.Struct(definition.input),
    failure: [...definition.errors, Unauthenticated, NotAllowed],
  };
}

// The one way into a handler, shared by every surface: refuse a missing
// principal, refuse one the Policy does not grant the action's permission,
// else run the handler.
export function invoke<
  Name extends string,
  Input extends Fields,
  Success extends Codec,
  Errors extends ErrorSchema,
  R,
>(
  action: Action<Name, Input, Success, Errors, R>,
  principal: Principal | undefined,
  input: InputOf<Input>,
): Effect.Effect<
  Success["Type"],
  Errors["Type"] | Unauthenticated | NotAllowed,
  R | Policy
> {
  if (principal === undefined)
    return Effect.fail(
      new Unauthenticated({ message: "no principal for this bearer" }),
    );
  return Effect.gen(function* () {
    const policy = yield* Policy;
    if (!(yield* policy.allows(principal, action.permission)))
      return yield* new NotAllowed({
        message: `${principal} lacks ${action.permission}`,
        action: action.name,
        permission: action.permission,
      });
    return yield* action.handler(input, principal);
  });
}

// Where a surface reports, once when it is built, the services its handlers
// will run on. Nothing listens by default; a test listens, to check that a
// handler runs on exactly those services and on nothing of the request's.
export const SurfaceServices = Context.Reference<{
  readonly built: (surface: string, keys: ReadonlyArray<string>) => void;
}>("action/SurfaceServices", { defaultValue: () => ({ built: () => {} }) });

// The services a surface's handlers run on: the context it is built in.
export function surfaceServices<R>(surface: string) {
  return Effect.gen(function* () {
    const services = yield* Effect.context<R | Policy>();
    const listener = yield* SurfaceServices;
    listener.built(surface, [...services.mapUnsafe.keys()]);
    return services;
  });
}

// The entry for a surface whose input reached it as an erased value. The
// surface has already decoded the input with the action's schema; this checks
// that it did, where the value is read, and stops loudly if not: a surface
// that skipped decoding is a bug, not a refusal.
//
// The handler runs on services, the context the surface was built with, in
// place of the request's own. The transport's request, and the bearer in it,
// is then absent from the handler's context at run time, not only from its
// type: a handler cannot reach a token even by a cast.
export function invokeDecoded<R>(
  action: AnyAction<R>,
  principal: Principal | undefined,
  input: unknown,
  services: Context.Context<R | Policy>,
) {
  const run = Schema.is(action.inputSchema)(input)
    ? invoke(action, principal, input)
    : Effect.die(
        new Error(`action: ${action.name} reached with an undecoded input`),
      );
  return Effect.updateContext(run, (_: Context.Context<never>) => services);
}

// The action with its own services given, so the projections see an action
// that needs nothing (R = never).
export function provideAction<R>(
  action: AnyAction<R>,
  services: Context.Context<R>,
): AnyAction {
  return {
    ...action,
    handler: (input, principal) =>
      action.handler(input, principal).pipe(Effect.provideContext(services)),
  };
}
