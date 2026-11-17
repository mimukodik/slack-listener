import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { step } from "../core.ts";
import { runSimulation, type StepFn } from "./simulator.ts";

describe("simulator", () => {
  it("R2 R4 R5 R7 R8 R10: seeded runs with faults keep every rule", () => {
    const totals: Record<string, number> = {};
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(fc.nat({ max: 1_000_000 }), { maxLength: 60 }),
        (seed, tape) => {
          const result = runSimulation({ seed, tape });
          for (const [key, value] of Object.entries(result.coverage))
            totals[key] = (totals[key] ?? 0) + value;
          if (!result.ok) throw new Error(`seed ${seed}: ${result.failure}`);
        },
      ),
      { numRuns: 200 },
    );
    for (const [key, value] of Object.entries(totals))
      expect(value, key).toBeGreaterThan(0);
  });
});

describe("three controls on the checks", () => {
  it("a build that delivers nothing fails a progress rule", () => {
    const refuseAll: StepFn = (state, event, now) => {
      const result = step(state, event, now);
      return {
        state: result.state,
        effects: result.effects.filter((e) => e.type !== "deliver"),
      };
    };
    const failures = [1, 2, 3, 4, 5].map(
      (seed) => runSimulation({ seed, step: refuseAll }).failure,
    );
    expect(
      failures.every(
        (f) => f !== null && (f.startsWith("R7") || f.startsWith("R8")),
      ),
    ).toBe(true);
  });

  it("a build that delivers every message unfiltered fails a safety rule", () => {
    const deliverAll: StepFn = (state, event, now) => {
      const result = step(state, event, now);
      if (event.type !== "envelope" || event.message === null) return result;
      const m = event.message;
      return {
        state: result.state,
        effects: [
          ...result.effects,
          {
            type: "deliver",
            delivery: {
              key: `raw:${m.ts}`,
              kind: "message",
              channel: m.channel ?? "",
              ts: m.ts,
              threadTs: m.thread_ts ?? m.ts,
              isReply: false,
              user: m.user ?? "",
              text: m.text ?? "",
              postedAtMs: now,
              editedAtMs: null,
              possibleDuplicate: false,
            },
          },
        ],
      };
    };
    const failures = [1, 2, 3, 4, 5].map(
      (seed) => runSimulation({ seed, step: deliverAll }).failure,
    );
    expect(
      failures.every((f) => f !== null && f.startsWith("SafetyViolation")),
    ).toBe(true);
  });
});
