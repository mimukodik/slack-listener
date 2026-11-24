# One listener in three languages

Can agents maintain a bounded, deterministic Zig listener faster than an equivalent safe Rust listener, at comparable observable correctness? How does the existing TypeScript/Effect implementation compare? The subject is the complete Slack listener. The task hub is a separate historical workload.

## Contract and implementation

Use [the frozen rules](https://github.com/mimukodik/slack-listener/blob/3a36ac759c5fccb0456b17121b81b6a6716a1aff/RULES.md) through the listener sections and [the English specification](https://github.com/mimukodik/slack-listener/blob/3a36ac759c5fccb0456b17121b81b6a6716a1aff/docs/en/specification.md). Use its historical TypeScript implementation as a calibration subject. Document disagreements against the written rule before changing an expected outcome. The comparison includes sender filtering, delivery and quoting, deduplication and edits, session handoff, restart and catch-up, retries, malformed input, reaction marks, state persistence and configuration. Each implementation needs a usable production entry point and production logic driven by fakes. Exercise all acceptance runs offline with synthetic inputs.

Port the behavior idiomatically. Keep event decisions deterministic, time explicit and I/O in the shell. Each target must bound pending work and explain overflow behavior. Document actual allocation, threading and ownership choices. In Zig specify startup and steady-state allocation boundaries and how they are checked. Prefer safe Rust in authored code and record any unsafe boundary. Keep the existing TypeScript/Effect toolchain as the reference. Do not require byte-identical internal traces across runtimes. Compare externally observed deliveries, acknowledgements, persistence across restart and reaction calls.

## Construction before measurement

The two new implementations are prospective build case studies. Their start commits, elapsed construction time, dependencies, failures, tool and cache setup are worth publishing. The existing TypeScript implementation had different tooling, prior design work and historical agents. Its original construction cost cannot be ranked against the two new ports. Start the comparative maintenance trial only after all three pass a common independent baseline gate. The originating implementers do not author that gate or score their own changes.

For an initial vertical slice, configure a synthetic channel and allowed sender, inject one Slack event, produce one quoted session delivery and the Slack acknowledgement, and demonstrate a disallowed sender. Extend through the complete contract. Use the same fixture on each runtime and state what this slice leaves untested. Record command, revision and result for each milestone; preserve unsuccessful attempts.

See [the registered maintenance protocol](measurement/PROTOCOL.md).
