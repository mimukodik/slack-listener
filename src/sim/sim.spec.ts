import { describe, expect, it } from "bun:test";

import fc from "fast-check";

import { runExhaustive } from "./exhaustive.ts";
import { runSeeds } from "./run.ts";
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
    // A run without a trace builds no lines and must run the same schedule:
    // the same steps and the same session as the traced run of its seed.
    for (const seed of [17, 18, 19]) {
      const traced = await runSimulation({ seed, actions: 30, trace: [] });
      const untraced = await runSimulation({ seed, actions: 30 });
      expect(untraced.steps, `seed ${seed}`).toBe(traced.steps);
      expect(untraced.session, `seed ${seed}`).toEqual(traced.session);
    }
    const differentTrace: string[] = [];
    await runSimulation({ seed: 18, actions: 30, trace: differentTrace });
    expect(differentTrace).not.toEqual(firstTrace);
  });
});

describe("sampled pass", () => {
  // Split across threads, the seeds must fail as a single thread's do, in
  // seed order. Two workers force the split on any runner.
  it("the seeds split across workers give the single-threaded failures", async () => {
    const single = await runSeeds(60, 40);
    const split = await runSeeds(60, 40, 2);
    expect(split).toEqual(single);
  }, 120_000);
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
  it("R2 R7 R10 R17 R18: no violation in any valid sequence up to 5 actions", async () => {
    const result = await runExhaustive(5);
    expect(result.violations).toEqual([]);
    // Counted by running every child of every prefix, without the prefix's
    // prediction (3,065 over the first eight letters, 11,620 with o, m and
    // f); a wrong "invalid" prediction would lower it.
    expect(result.sequences).toBe(11_620);
    for (const [name, count] of Object.entries(result.coverage))
      expect(count, name).toBeGreaterThan(0);
  }, 120_000);

  // Split across threads, the pass must give the single-threaded result,
  // violations in the same order. Two workers force the split on any runner.
  it("the pass split across workers gives the single-threaded result", async () => {
    const single = await runExhaustive(5);
    const split = await runExhaustive(5, 2);
    expect(split).toEqual(single);
  }, 120_000);

  // The R18 letters come last and read no choice, so the sequences without
  // them are the ones the eight-letter alphabet ran; a letter that changed
  // an earlier letter's validity would move this count.
  it("sequences without o, m and f are the eight-letter alphabet's", async () => {
    const tape: readonly number[] = Array.from({ length: 20_000 }, () => 0);
    const earlier = new Set<string>(["A", "B", "a", "b", "e", "d", "c", "u"]);
    const pending = [""];
    let sequences = 0;
    while (pending.length > 0) {
      const sequence = pending.pop() ?? "";
      const run = await new World({ seed: 1, faults: false, tape }).sequence(
        sequence,
      );
      expect(run.result.ok, `"${sequence}"`).toBe(true);
      sequences += 1;
      if (sequence.length < 5)
        for (const action of run.next)
          if (earlier.has(action)) pending.push(sequence + action);
    }
    expect(sequences).toBe(3065);
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
