// The projections against the definitions: the OpenAPI document describes
// every action as defined, a client that reads only the document can call an
// endpoint, and the MCP tool list says the same as the document. A surface
// that drifts from the definitions (a renamed field, a looser input, a lost
// error) fails here even when no call in the agreement property reaches it.
import { describe, expect, it } from "bun:test";

import { Context, Effect, Schema } from "effect";
import { McpProtocol, McpTest } from "effect/ai";

import { type AnyAction, provideAction } from "./action.ts";
import { platformLayer, makeWorld } from "./harness.ts";
import { apiOf, openApiOf } from "./http.ts";
import { registrationsOf, toolkitOf } from "./mcp.ts";
import {
  acknowledge,
  getReceipt,
  makeStore,
  ReceiptStore,
} from "./receipts.ts";

const services = Context.make(ReceiptStore, makeStore(["E1", "E2"]));
const actions: ReadonlyArray<AnyAction> = [
  provideAction(getReceipt, services),
  provideAction(acknowledge, services),
];

// The document as a client receives it: JSON.
const document: unknown = JSON.parse(
  JSON.stringify(openApiOf(apiOf("actions", actions))),
);

function at(value: unknown, ...path: ReadonlyArray<string | number>): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`not an object: ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
}

function list(value: unknown): ReadonlyArray<unknown> {
  if (!Array.isArray(value))
    throw new Error(`not an array: ${JSON.stringify(value)}`);
  return value;
}

// Effect writes additionalProperties false into the OpenAPI document and true
// into MCP's and the plain JSON Schema; every decoder ignores an extra field
// either way (DECISIONS.md, 2026-11-22). Everything else must match.
function withoutAdditional(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAdditional);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "additionalProperties")
      .map(([key, inner]) => [key, withoutAdditional(inner)]),
  );
}

// The JSON Schema of a definition's schema, with a top-level reference to a
// named definition (an error's identifier) resolved.
function jsonSchemaOf(schema: Schema.Top): unknown {
  const { schema: top, definitions } = Schema.toJsonSchemaDocument(schema);
  const reference = top["$ref"];
  const named =
    typeof reference === "string"
      ? definitions[reference.replace("#/$defs/", "")]
      : top;
  return withoutAdditional(named);
}

function statusOf(schema: Schema.Top): string {
  const status = Schema.resolveAnnotations(schema)?.["httpApiStatus"];
  if (typeof status !== "number") throw new Error("an error with no status");
  return String(status);
}

const methodOf = (action: AnyAction) =>
  action.kind === "query" ? "get" : "post";

const operationOf = (action: AnyAction) =>
  record(at(document, "paths", `/${action.name}`, methodOf(action)));

// The input as the document describes it: the request body of a POST, the
// query parameters of a GET put back together as one object schema.
function documentedInput(action: AnyAction): unknown {
  const operation = operationOf(action);
  if (action.kind === "mutation")
    return withoutAdditional(
      at(operation, "requestBody", "content", "application/json", "schema"),
    );
  const parameters = list(operation["parameters"]).map(record);
  for (const parameter of parameters) expect(parameter["in"]).toBe("query");
  return withoutAdditional({
    type: "object",
    properties: Object.fromEntries(
      parameters.map((parameter) => [parameter["name"], parameter["schema"]]),
    ),
    required: parameters
      .filter((parameter) => parameter["required"] === true)
      .map((parameter) => parameter["name"]),
  });
}

describe("the OpenAPI document", () => {
  it("lists every action, and only those, with its kind", () => {
    const paths = record(at(document, "paths"));
    expect(Object.keys(paths).sort()).toEqual(
      actions.map((action) => `/${action.name}`).sort(),
    );
    for (const action of actions) {
      const operation = operationOf(action);
      expect(operation["operationId"]).toBe(`actions.${action.name}`);
      expect(operation["description"]).toBe(action.description);
      expect(operation["security"]).toEqual([{ bearer: [] }]);
    }
    expect(at(document, "components", "securitySchemes", "bearer")).toEqual({
      type: "http",
      scheme: "Bearer",
    });
  });

  it("describes each input and output as the definition does", () => {
    for (const action of actions) {
      expect(documentedInput(action)).toEqual(jsonSchemaOf(action.inputSchema));
      expect(
        withoutAdditional(
          at(
            operationOf(action),
            "responses",
            "200",
            "content",
            "application/json",
            "schema",
          ),
        ),
      ).toEqual(jsonSchemaOf(action.success));
    }
    // The constraint on the id reaches the document, not only the type.
    expect(
      at(
        document,
        "paths",
        "/getReceipt",
        "get",
        "parameters",
        0,
        "schema",
        "pattern",
      ),
    ).toBe("^E[0-9]{1,6}$");
  });

  it("gives every error the action may fail with, at its status, with its tag", () => {
    for (const action of actions) {
      const responses = record(at(operationOf(action), "responses"));
      expect(Object.keys(responses).sort()).toEqual(
        ["200", ...action.failure.map(statusOf)].sort(),
      );
      for (const error of action.failure) {
        const reference = at(
          responses,
          statusOf(error),
          "content",
          "application/json",
          "schema",
          "$ref",
        );
        expect(reference).toBe(
          `#/components/schemas/${error.identifier}Encoded`,
        );
        const component = at(
          document,
          "components",
          "schemas",
          `${error.identifier}Encoded`,
        );
        expect(at(component, "properties", "_tag", "enum")).toEqual([
          error.identifier,
        ]);
        expect(withoutAdditional(component)).toEqual(jsonSchemaOf(error));
      }
    }
  });

  it("is enough to call an endpoint: a client built from the document alone", async () => {
    // Everything below comes from the document: path, method, where the
    // input goes, how the bearer travels, what a success looks like.
    const operation = record(at(document, "paths", "/getReceipt", "get"));
    const [parameter] = list(operation["parameters"]).map(record);
    if (parameter === undefined) throw new Error("no parameter");
    const scheme = record(
      at(document, "components", "securitySchemes", "bearer"),
    );
    const url = new URL(`http://actions.invalid/getReceipt`);
    url.searchParams.set(String(parameter["name"]), "E1");
    const request = new Request(url, {
      method: "GET",
      headers: { authorization: `${String(scheme["scheme"])} t-alice` },
    });
    const documented = at(
      operation,
      "responses",
      "200",
      "content",
      "application/json",
      "schema",
    );

    const { status, body } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const world = yield* makeWorld(actions);
          const response = yield* Effect.promise(async () =>
            world.fetch(request),
          );
          const text = yield* Effect.promise(async () => response.text());
          return { status: response.status, body: JSON.parse(text) as unknown };
        }),
      ).pipe(Effect.provide(platformLayer)),
    );
    expect(status).toBe(200);
    // The body has exactly the documented fields, and the definition's
    // decoder accepts it.
    expect(Object.keys(record(body)).sort()).toEqual(
      list(at(documented, "required")).map(String).sort(),
    );
    expect(body).toEqual({ eventId: "E1", receipt: null });
    expect(Schema.is(Schema.toCodecJson(getReceipt.success))(body)).toBe(true);
  });
});

describe("the MCP tool list", () => {
  it("has one tool per action, with the definition's input and output", async () => {
    const listed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* McpTest.makeClient(
            registrationsOf(toolkitOf(actions), actions),
            { protocols: [McpProtocol.v2026_07_28] },
          );
          return yield* client.listTools({});
        }),
      ).pipe(Effect.provide(platformLayer), Effect.orDie),
    );
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      actions.map((action) => action.name).sort(),
    );
    for (const action of actions) {
      const tool = listed.tools.find((each) => each.name === action.name);
      if (tool === undefined) throw new Error(`no tool ${action.name}`);
      expect(tool.description).toBe(action.description);
      expect(withoutAdditional(tool.inputSchema)).toEqual(
        jsonSchemaOf(action.inputSchema),
      );
      expect(withoutAdditional(tool.outputSchema)).toEqual(
        jsonSchemaOf(action.success),
      );
      expect(tool.annotations?.readOnlyHint).toBe(action.kind === "query");
      // The same input schema the REST surface documents.
      expect(withoutAdditional(tool.inputSchema)).toEqual(
        documentedInput(action),
      );
    }
  });
});
