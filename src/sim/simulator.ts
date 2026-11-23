import { defaultLimits, type CoreConfig, type Delivery } from "../core.ts";
import { people, watchedChannel, type SlackFake } from "./slack-fake.ts";
import { World } from "./world.ts";

export interface SimOptions {
  seed: number;
  tape?: readonly number[];
  actions?: number;
  faults?: boolean;
  trace?: string[];
  control?: "nothing" | "everything";
  // Swarm testing (BER-2419): switch a seeded half of the world's action
  // kinds and fault classes off for this run.
  swarm?: boolean;
}

export interface SessionRecord {
  delivery: Delivery;
  atMs: number;
  crashesBefore: number;
}

export interface Coverage {
  duplicateEnvelopes: number;
  reorderedArrivals: number;
  crashes: number;
  crashesWithInflight: number;
  disconnects: number;
  postsWhileDisconnected: number;
  threadRepliesDelivered: number;
  broadcastsDelivered: number;
  editsDelivered: number;
  ownAgentPostsDropped: number;
  sinkFailures: number;
  repliesFetched: number;
  apiFailures: number;
  retriedEnvelopes: number;
  sleeps: number;
  staleCatchUpReplies: number;
  injectionTexts: number;
  sameTextEdits: number;
  reactionsAdded: number;
  reactionsRemoved: number;
  reactionFaults: number;
  doneMarks: number;
  malformedFrames: number;
  malformedEnvelopes: number;
  malformedAnswers: number;
  malformedLines: number;
  unreadableInCatchUp: number;
  repliesUnderUnreadable: number;
}

export interface SimResult {
  ok: boolean;
  failure: string | null;
  steps: number;
  coverage: Coverage;
  // The swarm mask, what the run left on; null in a plain run.
  swarm: readonly string[] | null;
  session: SessionRecord[];
  slack: SlackFake;
  floorMs: number;
}

export const simStartMs = 1_794_900_000_000;

export function simConfig(): CoreConfig {
  return {
    channel: watchedChannel,
    ownPeople: [people.own],
    otherPeople: [people.other],
    ownBots: [people.ownBot],
    otherBots: [people.otherBot],
    ...defaultLimits,
  };
}

export async function runSimulation(options: SimOptions): Promise<SimResult> {
  const world = new World(options);
  return world.sample();
}
