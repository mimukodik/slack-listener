// Turns recorded Socket Mode frames (config "recordFile") into fixtures:
//   node src/sim/conformance/import.ts <frames.ndjson> <config.json>
// It prints one new fixture per kind and author not already in fixtures.json.
// Read the output, then add what is new; a surprise from real Slack becomes a
// fixture first and a change to the fake second.

import { readFileSync, writeFileSync } from "node:fs";

import type { SlackMessage } from "../../slack.ts";
import {
  anonymise,
  authorOf,
  kindOf,
  labelOf,
  type Fixture,
  type Sides,
} from "./fixture.ts";

const [framesPath, configPath] = process.argv.slice(2);
if (framesPath === undefined || configPath === undefined) {
  console.error("usage: import.ts <frames.ndjson> <config.json>");
  process.exit(2);
}
const config = JSON.parse(readFileSync(configPath, "utf8")) as Partial<Sides>;
const sides: Sides = {
  channel: config.channel ?? "",
  ownPeople: config.ownPeople ?? [],
  otherPeople: config.otherPeople ?? [],
  ownBots: config.ownBots ?? [],
  otherBots: config.otherBots ?? [],
};
const fixturesPath = new URL("fixtures.json", import.meta.url);
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8")) as Fixture[];
const have = new Set(fixtures.map((f) => `${f.kind}:${f.label}`));

let added = 0;
for (const line of readFileSync(framesPath, "utf8").split("\n")) {
  if (line.trim() === "") continue;
  const frame = JSON.parse(line) as {
    type?: string;
    payload?: { event?: SlackMessage; event_time?: number };
  };
  const event = frame.payload?.event;
  if (frame.type !== "events_api" || event?.type !== "message") continue;
  if (event.channel !== sides.channel) continue;
  const kind = kindOf(event);
  const label = labelOf(sides, authorOf(event));
  if (have.has(`${kind}:${label}`)) continue;
  have.add(`${kind}:${label}`);
  fixtures.push({
    kind,
    label,
    recordedAt: new Date((frame.payload?.event_time ?? 0) * 1000)
      .toISOString()
      .slice(0, 10),
    event: anonymise(sides, event),
  });
  added += 1;
  console.log(`new fixture: ${kind} by ${label}`);
}
writeFileSync(fixturesPath, `${JSON.stringify(fixtures, null, 2)}\n`);
console.log(`${added} added, ${fixtures.length} fixtures`);
