import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { runExhaustive } from "./exhaustive.ts";
import { runSimulation } from "./simulator.ts";
import { type Action, World, alphabet } from "./world.ts";

describe("simulator", () => {
  it("R2 R4 R5 R7 R8 R10: whole-program seeded runs keep every rule", async () => {
    const totals: Record<string, number> = {};
    await fc.assert(
      fc.asyncProperty(
        fc.integer(),
        fc.array(fc.nat({ max: 1_000_000 }), { maxLength: 60 }),
        async (seed, tape) => {
          const result = await runSimulation({ seed, tape });
          for (const [key, value] of Object.entries(result.coverage))
            totals[key] = (totals[key] ?? 0) + value;
          if (!result.ok) throw new Error(`seed ${seed}: ${result.failure}`);
        },
      ),
      { numRuns: 200 },
    );
    for (const [key, value] of Object.entries(totals))
      expect(value, key).toBeGreaterThan(0);
  }, 120_000);

  it("the same whole-program seed replays stdout, disk and scheduler choices", async () => {
    const firstTrace: string[] = [];
    const secondTrace: string[] = [];
    const first = await runSimulation({
      seed: 17,
      actions: 30,
      trace: firstTrace,
    });
    const second = await runSimulation({
      seed: 17,
      actions: 30,
      trace: secondTrace,
    });
    expect(first.ok, first.failure ?? "").toBe(true);
    expect(second).toEqual(first);
    expect(secondTrace).toEqual(firstTrace);
    const differentTrace: string[] = [];
    await runSimulation({ seed: 18, actions: 30, trace: differentTrace });
    expect(differentTrace).not.toEqual(firstTrace);
  });
});

describe("two controls on the observations", () => {
  it("no observed delivery fails progress", async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const result = await runSimulation({ seed, control: "nothing" });
      expect(result.failure).toMatch(/R7|R8/);
    }
  });
  it("observing every message without filtering fails safety", async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const result = await runSimulation({ seed, control: "everything" });
      expect(result.failure).toMatch(/SafetyViolation|R10|R4|R2|R17/);
    }
  });
});

describe("bounded exhaustive pass", () => {
  it("R2 R7 R10 R17: no violation in any valid sequence up to 5 actions", async () => {
    const result = await runExhaustive(5);
    expect(result.violations).toEqual([]);
    expect(result.sequences).toBeGreaterThan(1000);
    for (const [name, count] of Object.entries(result.coverage))
      expect(count, name).toBeGreaterThan(0);
  }, 120_000);

  // The pass runs only the children a prefix predicts valid. Running every
  // child of every valid prefix up to 3 actions must give the same sets.
  it("a prefix predicts exactly which next actions are valid", async () => {
    const tape: readonly number[] = Array.from({ length: 20_000 }, () => 0);
    const run = async (sequence: string) =>
      new World({ seed: 1, faults: false, tape }).sequence(sequence);
    const prefixes = [""];
    let checked = 0;
    while (prefixes.length > 0) {
      const prefix = prefixes.pop() ?? "";
      const parent = await run(prefix);
      const valid: Action[] = [];
      for (const action of alphabet)
        if ((await run(prefix + action)).valid) valid.push(action);
      expect(parent.next, `after "${prefix}"`).toEqual(valid);
      checked += 1;
      if (prefix.length < 3)
        for (const action of valid) prefixes.push(prefix + action);
    }
    expect(checked).toBeGreaterThan(100);
  }, 120_000);
});
