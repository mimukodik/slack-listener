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

export function tsToMs(ts: string): number {
  const [seconds, fraction = ""] = ts.split(".");
  return Number(seconds) * 1000 + Number(fraction.padEnd(6, "0").slice(0, 3));
}

export function msToTs(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const millis = ms - seconds * 1000;
  return `${seconds}.${String(millis).padStart(3, "0")}000`;
}

export function compareTs(a: string, b: string): number {
  const [aSeconds, aFraction = ""] = a.split(".");
  const [bSeconds, bFraction = ""] = b.split(".");
  if (aSeconds.length !== bSeconds.length)
    return aSeconds.length - bSeconds.length;
  if (aSeconds !== bSeconds) return aSeconds < bSeconds ? -1 : 1;
  const left = aFraction.padEnd(6, "0");
  const right = bFraction.padEnd(6, "0");
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
