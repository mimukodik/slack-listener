import { Schema } from "effect";

export interface SlackMessage {
  type?: string;
  subtype?: string;
  channel?: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  latest_reply?: string;
  reply_count?: number;
  edited?: { user?: string; ts: string };
  message?: SlackMessage;
  previous_message?: SlackMessage;
}

// R21: what a catch-up needs of a thread parent that does not decode as a
// message: where it is, and whether its thread has replies to read.
export type ThreadStub = Pick<
  SlackMessage,
  "ts" | "reply_count" | "latest_reply"
>;

// A Slack timestamp: seconds, a dot and a fraction, as tsToMs reads it.
export const SlackTs = Schema.String.check(Schema.isPattern(/^\d+\.\d+$/));

// A Slack message as it arrives in a Socket Mode event, a Web API answer or
// the state file: the fields the listener reads, each of its type, and a ts.
// Fields it does not read are dropped.
export const SlackMessageSchema: Schema.Codec<SlackMessage> = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  subtype: Schema.optionalKey(Schema.String),
  channel: Schema.optionalKey(Schema.String),
  user: Schema.optionalKey(Schema.String),
  bot_id: Schema.optionalKey(Schema.String),
  app_id: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  ts: SlackTs,
  thread_ts: Schema.optionalKey(SlackTs),
  latest_reply: Schema.optionalKey(SlackTs),
  reply_count: Schema.optionalKey(Schema.Finite),
  edited: Schema.optionalKey(
    Schema.Struct({ user: Schema.optionalKey(Schema.String), ts: SlackTs }),
  ),
  message: Schema.optionalKey(Schema.suspend(() => SlackMessageSchema)),
  previous_message: Schema.optionalKey(
    Schema.suspend(() => SlackMessageSchema),
  ),
});

export function tsToMs(ts: string): number {
  const [seconds, fraction = ""] = ts.split(".");
  return Number(seconds) * 1000 + Number(fraction.padEnd(6, "0").slice(0, 3));
}

export function msToTs(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const millis = ms - seconds * 1000;
  return `${seconds}.${String(millis).padStart(3, "0")}000`;
}

function tsParts(ts: string): [seconds: string, fraction: string] {
  const [seconds, fraction = ""] = ts.split(".");
  if (seconds === undefined)
    throw new Error(`slack: ts without seconds: ${ts}`);
  return [seconds, fraction];
}

export function compareTs(a: string, b: string): number {
  const [aSeconds, aFraction] = tsParts(a);
  const [bSeconds, bFraction] = tsParts(b);
  if (aSeconds.length !== bSeconds.length)
    return aSeconds.length - bSeconds.length;
  if (aSeconds !== bSeconds) return aSeconds < bSeconds ? -1 : 1;
  const left = aFraction.padEnd(6, "0");
  const right = bFraction.padEnd(6, "0");
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
