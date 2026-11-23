// One thread of the pool: runs each task it is sent and answers with its
// result (BER-2207, BER-2216).
import { parentPort } from "node:worker_threads";

import { emptyResult, explore } from "./exhaustive.ts";
import type { Answer, Reply, Task } from "./pool.ts";
import { seedFailures } from "./run.ts";

const port = parentPort;
if (port === null) throw new Error("pool-worker runs only as a worker");

async function perform(task: Task): Promise<Answer<Task>> {
  switch (task.kind) {
    case "subtree": {
      const result = emptyResult(task.bound);
      await explore(task.root, result);
      return result;
    }
    case "seeds":
      return seedFailures(task.first, task.last, task.actions);
  }
}

port.on("message", ({ index, task }: { index: number; task: Task }) => {
  perform(task).then(
    (answer) => port.postMessage({ index, answer } satisfies Reply),
    (error: unknown) =>
      port.postMessage({
        index,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      } satisfies Reply),
  );
});
