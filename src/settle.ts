export interface ThreadPost {
  ts: string;
  agent: boolean;
  replyNeeded: boolean;
}

export interface SettleConfig {
  agentRunCap: number;
}

export const defaultSettle: SettleConfig = { agentRunCap: 20 };

export const noReplyMarker = "No reply needed.";

export type ReplyDecision =
  | { allowed: true }
  | { allowed: false; reason: "needs_human" | "no_reply_needed" };

export function agentRun(posts: readonly ThreadPost[]): number {
  let run = 0;
  for (let i = posts.length - 1; i >= 0; i -= 1) {
    if (!(posts[i] as ThreadPost).agent) break;
    run += 1;
  }
  return run;
}

export function replyDecision(
  posts: readonly ThreadPost[],
  config: SettleConfig,
): ReplyDecision {
  if (agentRun(posts) >= config.agentRunCap)
    return { allowed: false, reason: "needs_human" };
  const last = posts.at(-1);
  if (last !== undefined && last.agent && !last.replyNeeded)
    return { allowed: false, reason: "no_reply_needed" };
  return { allowed: true };
}

export function footer(
  agent: string,
  person: string,
  replyNeeded: boolean,
): string {
  const base = `_${agent} for ${person}; ${person} did not review it._`;
  return replyNeeded ? base : `${base} ${noReplyMarker}`;
}

export function replyNeededFromText(text: string): boolean {
  return (
    !text.trimEnd().endsWith(noReplyMarker) &&
    !text.trimEnd().endsWith(`${noReplyMarker}_`)
  );
}
