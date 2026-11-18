// The listener's log: one line per event on stderr, with the Clock's time, so
// the simulator's clock stamps it too. Tokens are redacted from every line.
import { Clock, DateTime, Effect, Semaphore, Stdio, Stream } from "effect";

import { redact } from "./slack-api.ts";

export type Log = (line: string) => Effect.Effect<void>;

export const makeLog: Effect.Effect<Log, never, Stdio.Stdio> = Effect.gen(
  function* () {
    const stdio = yield* Stdio.Stdio;
    const oneWriter = yield* Semaphore.make(1);
    return (line) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowMs) =>
          Stream.run(
            Stream.succeed(
              `${DateTime.formatIso(DateTime.makeUnsafe(nowMs))} slack-listener ${redact(line)}\n`,
            ),
            stdio.stderr({ endOnDone: false }),
          ),
        ),
        Semaphore.withPermits(oneWriter, 1),
        Effect.ignore,
      );
  },
);
