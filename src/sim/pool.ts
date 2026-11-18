// Runs independent simulator work on worker threads: subtrees of the
// exhaustive pass and ranges of seeds. Each task goes to the next idle
// worker, and the answers come back in task order, so a split run reports
// what a single thread would (BER-2207, BER-2216).
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

import type { ExhaustiveResult } from "./exhaustive.ts";

// More than 8 workers was slower on a 14-core Mac (BER-2207).
export const defaultWorkers = Math.min(availableParallelism(), 8);

export type Task =
  | { readonly kind: "subtree"; readonly root: string; readonly bound: number }
  | {
      readonly kind: "seeds";
      readonly first: number;
      readonly last: number;
      readonly actions: number;
    };

export type Answer<T extends Task> = T extends { readonly kind: "subtree" }
  ? ExhaustiveResult
  : readonly string[];

export type Reply =
  | { readonly index: number; readonly answer: Answer<Task> }
  | { readonly index: number; readonly error: string };

export async function runPool<T extends Task>(
  tasks: readonly T[],
  workers: number,
): Promise<Answer<T>[]> {
  const answers: (Answer<T> | undefined)[] = tasks.map(() => undefined);
  const started: Worker[] = [];
  let next = 0;
  let received = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const give = (worker: Worker): void => {
        if (next < tasks.length) {
          worker.postMessage({ index: next, task: tasks[next] });
          next += 1;
        }
      };
      for (let i = 0; i < Math.min(workers, tasks.length); i += 1) {
        const worker = new Worker(new URL("./pool-worker.ts", import.meta.url));
        started.push(worker);
        worker.on("message", (reply: Reply) => {
          if ("error" in reply) {
            reject(new Error(`simulation worker: ${reply.error}`));
            return;
          }
          if (answers[reply.index] !== undefined)
            reject(new Error(`simulation: task ${reply.index} answered twice`));
          answers[reply.index] = reply.answer as Answer<T>;
          received += 1;
          if (received === tasks.length) resolve();
          else give(worker);
        });
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (received < tasks.length)
            reject(
              new Error(
                `simulation worker exited with ${code} before every task was answered`,
              ),
            );
        });
        give(worker);
      }
    });
  } finally {
    await Promise.all(started.map(async (worker) => worker.terminate()));
  }
  return answers.map((answer, index) => {
    if (answer === undefined)
      throw new Error(`simulation: task ${index} was not answered`);
    return answer;
  });
}
