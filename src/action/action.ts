// The action contract: one definition per action, from which every surface
// (REST, MCP, atoms) is generated (DECISIONS.md, 2026-11-22: the action
// contract). An action is a name, a description, a Schema input and success
// value, its typed errors, who may call it, whether it reads or writes, and a
// handler. Nothing here knows about HTTP, MCP or atoms.
//
// Every surface reaches the handler through invoke, which holds the two
// refusals every action shares: no caller (Unauthenticated) and a caller the
// action does not allow (NotAllowed). Each surface decodes the input with the
// action's own schema where the input enters (decode-at-the-boundary), so
// invoke receives a decoded input and a resolved caller, never raw data.
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

// Who is calling: plain data, resolved from a credential by Callers.
export type Role = "member" | "reader" | "outsider";
export type Caller = { readonly id: string; readonly role: Role };

// Maps a credential to a caller. Every surface resolves its credential through
// this one service, so a credential means the same caller everywhere.
export class Callers extends Context.Service<
  Callers,
  { readonly authenticate: (credential: string) => Caller | undefined }
>()("action/Callers") {}

// The caller a surface resolved for the current call, or none. Each surface
// provides it from its own transport (DECISIONS.md: how the caller travels).
export class CurrentCaller extends Context.Service<
  CurrentCaller,
  { readonly caller: Caller | undefined }
>()("action/CurrentCaller") {}

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
  { message: Schema.String, action: Schema.String },
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
  // Pure: the caller and the decoded input in, the answer out. Both are
  // methods, so an action with a narrower input is still an AnyAction.
  allow(caller: Caller, input: InputOf<Input>): boolean;
  handler(
    input: InputOf<Input>,
    caller: Caller,
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
// caller, refuse a caller the action does not allow, else run the handler.
export function invoke<
  Name extends string,
  Input extends Fields,
  Success extends Codec,
  Errors extends ErrorSchema,
  R,
>(
  action: Action<Name, Input, Success, Errors, R>,
  caller: Caller | undefined,
  input: InputOf<Input>,
): Effect.Effect<
  Success["Type"],
  Errors["Type"] | Unauthenticated | NotAllowed,
  R
> {
  if (caller === undefined)
    return Effect.fail(
      new Unauthenticated({ message: "no caller for this credential" }),
    );
  if (!action.allow(caller, input))
    return Effect.fail(
      new NotAllowed({
        message: `${caller.id} may not call ${action.name}`,
        action: action.name,
      }),
    );
  return action.handler(input, caller);
}

// The entry for a surface whose input reached it as an erased value. The
// surface has already decoded the input with the action's schema; this checks
// that it did, where the value is read, and stops loudly if not: a surface
// that skipped decoding is a bug, not a refusal.
export function invokeDecoded<R>(
  action: AnyAction<R>,
  caller: Caller | undefined,
  input: unknown,
) {
  return Schema.is(action.inputSchema)(input)
    ? invoke(action, caller, input)
    : Effect.die(
        new Error(`action: ${action.name} reached with an undecoded input`),
      );
}

// The action with its own services given, so the projections see an action
// that needs nothing (R = never).
export function provideAction<R>(
  action: AnyAction<R>,
  services: Context.Context<R>,
): AnyAction {
  return {
    ...action,
    handler: (input, caller) =>
      action.handler(input, caller).pipe(Effect.provideContext(services)),
  };
}
