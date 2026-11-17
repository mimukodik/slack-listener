import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  agentRun,
  footer,
  replyDecision,
  replyNeededFromText,
  type SettleConfig,
  type ThreadPost,
} from "./settle.ts";
import { Choices } from "./sim/choices.ts";

interface TwoSideResult {
  maxRun: number;
  postsAfterHumansStopped: number;
  settledWithin: number | null;
  refusals: number;
  acknowledgements: number;
}

function twoInstances(
  seed: number,
  config: SettleConfig,
  ackPercent: number,
): TwoSideResult {
  const choices = new Choices(seed);
  const threads: ThreadPost[][] = [
    [{ ts: "0", agent: false, replyNeeded: true }],
  ];
  const lastSide: Array<"a" | "b" | "human"> = ["human"];
  let clock = 1;
  let maxRun = 0;
  let refusals = 0;
  let acknowledgements = 0;
  let postsAfterHumansStopped = 0;
  let settledWithin: number | null = null;
  const humanRounds = 30;
  for (let round = 0; round < 400; round += 1) {
    const humansActive = round < humanRounds;
    if (humansActive && choices.chance(20)) {
      if (choices.chance(30)) {
        threads.push([
          { ts: String(clock++), agent: false, replyNeeded: true },
        ]);
        lastSide.push("human");
      } else {
        const index = choices.int(threads.length);
        (threads[index] as ThreadPost[]).push({
          ts: String(clock++),
          agent: false,
          replyNeeded: true,
        });
        lastSide[index] = "human";
      }
    }
    let posted = 0;
    const snapshot = threads.map((posts) => [...posts]);
    for (const side of ["a", "b"] as const) {
      snapshot.forEach((posts, index) => {
        if (lastSide[index] === side) return;
        const decision = replyDecision(posts, config);
        if (!decision.allowed) {
          refusals += 1;
          return;
        }
        const replyNeeded = !choices.chance(ackPercent);
        if (!replyNeeded) acknowledgements += 1;
        (threads[index] as ThreadPost[]).push({
          ts: String(clock++),
          agent: true,
          replyNeeded,
        });
        lastSide[index] = side;
        posted += 1;
      });
    }
    for (const posts of threads) maxRun = Math.max(maxRun, agentRun(posts));
    if (!humansActive) {
      postsAfterHumansStopped += posted;
      if (posted === 0 && settledWithin === null)
        settledWithin = round - humanRounds;
    }
    if (settledWithin !== null && posted > 0) settledWithin = null;
  }
  return {
    maxRun,
    postsAfterHumansStopped,
    settledWithin,
    refusals,
    acknowledgements,
  };
}

describe("R12 and R13: two instances whose agents answer every message settle", () => {
  it("R12: the agent run in a thread never exceeds the cap by more than one, and posting stops", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.integer({ min: 1, max: 25 }),
        fc.integer({ min: 0, max: 60 }),
        (seed, cap, ack) => {
          const result = twoInstances(seed, { agentRunCap: cap }, ack);
          expect(result.maxRun).toBeLessThanOrEqual(cap + 1);
          expect(result.settledWithin).not.toBeNull();
        },
      ),
      { numRuns: 300 },
    );
  });

  it("R12: with no acknowledgements at all, the cap alone stops two always-answering agents", () => {
    const result = twoInstances(7, { agentRunCap: 4 }, 0);
    expect(result.settledWithin).not.toBeNull();
    expect(result.refusals).toBeGreaterThan(0);
    expect(result.acknowledgements).toBe(0);
  });

  it("R12: a person typing in the thread opens it again", () => {
    const posts: ThreadPost[] = Array.from({ length: 4 }, (_, i) => ({
      ts: String(i),
      agent: true,
      replyNeeded: true,
    }));
    expect(replyDecision(posts, { agentRunCap: 4 })).toEqual({
      allowed: false,
      reason: "needs_human",
    });
    posts.push({ ts: "9", agent: false, replyNeeded: true });
    expect(replyDecision(posts, { agentRunCap: 4 })).toEqual({ allowed: true });
  });

  it("R13: an acknowledgement is not answered until a later message asks for a reply", () => {
    const posts: ThreadPost[] = [{ ts: "1", agent: true, replyNeeded: false }];
    expect(replyDecision(posts, { agentRunCap: 20 })).toEqual({
      allowed: false,
      reason: "no_reply_needed",
    });
    posts.push({ ts: "2", agent: true, replyNeeded: true });
    expect(replyDecision(posts, { agentRunCap: 20 })).toEqual({
      allowed: true,
    });
  });

  it("R11 and R13: the footer names agent and person, and carries the marker only when no reply is needed", () => {
    const ack = `Received, thanks.\n${footer("checker", "Alex", false)}`;
    const ask = `Can you check this?\n${footer("checker", "Alex", true)}`;
    expect(ack).toContain("checker for Alex; Alex did not review it.");
    expect(replyNeededFromText(ack)).toBe(false);
    expect(replyNeededFromText(ask)).toBe(true);
  });
});
