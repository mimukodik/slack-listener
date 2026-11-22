// Decoding at the boundary (PRINCIPLES.md: decode-at-the-boundary): every
// value from outside is decoded once, where it enters, with a Schema. What a
// failure says names the field and what was expected, never the value, so no
// message text or token reaches a log line or an error (R6).
import { SchemaIssue } from "effect";
import type { Schema } from "effect";

const formatter = SchemaIssue.makeFormatterStandardSchemaV1();

// "at queue.0.ts: Expected string": the first issue, by its path. The
// formatter names a value only when the parse reports its input, which this
// code never asks for.
export function describeIssue(error: Schema.SchemaError): string {
  const first = formatter(error.issue).issues[0];
  if (first === undefined) return "does not decode";
  const path = (first.path ?? [])
    .map((segment) =>
      String(typeof segment === "object" ? segment.key : segment),
    )
    .join(".");
  return path === ""
    ? `does not decode: ${first.message}`
    : `does not decode at ${path}: ${first.message}`;
}
