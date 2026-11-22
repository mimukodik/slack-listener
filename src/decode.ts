// Decoding at the boundary (PRINCIPLES.md: decode-at-the-boundary): every
// value from outside is decoded once, where it enters, with a Schema. What a
// failure says names the field and what was expected, never the value, so no
// message text or token reaches a log line or an error (R6).
import { SchemaIssue } from "effect";
import type { Schema } from "effect";

const formatter = SchemaIssue.makeFormatterStandardSchemaV1();

// "at queue.0.ts: Expected string": the first issue, by its path. The
// formatter names a value only when the parse reports its input, which this
// code never asks for. A path into a map passes through one of its keys,
// which is text from the input too: maps names the fields that are maps,
// and the segment after one of them is shown as [key].
export function describeIssue(
  error: Schema.SchemaError,
  maps: readonly string[] = [],
): string {
  const first = formatter(error.issue).issues[0];
  if (first === undefined) return "does not decode";
  const segments = (first.path ?? []).map((segment) =>
    String(typeof segment === "object" ? segment.key : segment),
  );
  const path = segments
    .map((segment, i) =>
      i > 0 && maps.includes(segments[i - 1] ?? "") ? "[key]" : segment,
    )
    .join(".");
  return path === ""
    ? `does not decode: ${first.message}`
    : `does not decode at ${path}: ${first.message}`;
}
