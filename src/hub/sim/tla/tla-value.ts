// A reader for the TLA+ values TLC prints: records, sequences, sets,
// functions written with :> and @@, strings, numbers, booleans and model
// values (kept as their names). Used by the local scripts in spec/tasks.
export type Value =
  | string
  | number
  | boolean
  | readonly Value[]
  | { readonly [key: string]: Value };

const token =
  /\s*(<<|>>|\|->|:>|@@|\[|\]|\(|\)|\{|\}|,|"(?:[^"\\]|\\.)*"|-?\d+|[A-Za-z_][A-Za-z0-9_]*)/y;

export function parseValue(source: string): Value {
  const tokens: string[] = [];
  token.lastIndex = 0;
  for (;;) {
    const at = token.lastIndex;
    const match = token.exec(source);
    if (match === null) {
      if (source.slice(at).trim() !== "")
        throw new Error(`tla: cannot read at ${source.slice(at, at + 40)}`);
      break;
    }
    tokens.push(match[1] ?? "");
  }
  let i = 0;
  const peek = (): string | undefined => tokens[i];
  const take = (expected?: string): string => {
    const next = tokens[i];
    if (next === undefined || (expected !== undefined && next !== expected))
      throw new Error(
        `tla: expected ${expected ?? "a token"}, got ${String(next)}`,
      );
    i += 1;
    return next;
  };
  const list = (close: string): Value[] => {
    const items: Value[] = [];
    if (peek() === close) {
      take(close);
      return items;
    }
    for (;;) {
      items.push(expr());
      if (peek() === ",") take(",");
      else break;
    }
    take(close);
    return items;
  };
  const primary = (): Value => {
    const next = take();
    if (next === "[") {
      const fields: Record<string, Value> = {};
      for (;;) {
        const name = take();
        take("|->");
        fields[name] = expr();
        if (peek() === ",") take(",");
        else break;
      }
      take("]");
      return fields;
    }
    if (next === "<<") return list(">>");
    if (next === "{") return list("}");
    if (next === "(") {
      const inner = expr();
      take(")");
      return inner;
    }
    if (next.startsWith('"')) return JSON.parse(next) as string;
    if (/^-?\d+$/u.test(next)) return Number(next);
    if (next === "TRUE") return true;
    if (next === "FALSE") return false;
    return next;
  };
  // A function written k :> v @@ k :> v becomes an object keyed by k.
  const expr = (): Value => {
    const pairs: [string, Value][] = [];
    let single: Value | undefined;
    for (;;) {
      const left = primary();
      if (peek() === ":>") {
        take(":>");
        if (typeof left === "object")
          throw new Error("tla: a function's key must be a scalar");
        pairs.push([String(left), primary()]);
      } else if (pairs.length === 0) single = left;
      else if (typeof left === "object" && !Array.isArray(left))
        for (const [key, inner] of Object.entries(left))
          pairs.push([key, inner]);
      if (peek() === "@@") take("@@");
      else break;
    }
    return single !== undefined && pairs.length === 0
      ? single
      : Object.fromEntries(pairs);
  };
  const value = expr();
  if (i !== tokens.length) throw new Error("tla: trailing tokens");
  return value;
}

// A state as TLC prints it: "/\ name = value" per variable.
export function parseState(source: string): Record<string, Value> {
  const state: Record<string, Value> = {};
  const parts = source.split(/^\/\\ /mu).filter((part) => part.trim() !== "");
  for (const part of parts) {
    const at = part.indexOf(" = ");
    state[part.slice(0, at).trim()] = parseValue(part.slice(at + 3));
  }
  return state;
}
