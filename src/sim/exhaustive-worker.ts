// One thread of the split exhaustive pass: runs each subtree root it is sent
// and answers with its part of the result (BER-2207).
import { parentPort } from "node:worker_threads";

import { type WorkerReply, emptyResult, explore } from "./exhaustive.ts";

const port = parentPort;
if (port === null) throw new Error("exhaustive-worker runs only as a worker");

port.on(
  "message",
  ({ index, root, bound }: { index: number; root: string; bound: number }) => {
    const result = emptyResult(bound);
    explore(root, result).then(
      () => port.postMessage({ index, result } satisfies WorkerReply),
      (error: unknown) =>
        port.postMessage({
          index,
          error:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        } satisfies WorkerReply),
    );
  },
);
