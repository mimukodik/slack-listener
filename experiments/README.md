# Architecture experiments for Agent Native

We are deciding how to build and maintain software with coding agents across desktop, mobile, web and systems workloads. Each study keeps its question, prior expectations, methods, evidence, failed attempts and the decision that evidence supports. A negative or inconclusive study belongs in the record.

| Study                                                                            | Status                                          | Evidence and scope                                                                                                                           |
| -------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [Effect, TigerStyle and deterministic simulation](../history/arch-poc/README.md) | Historical checkpoint                           | Working listener and task hub, full plan, faults found, runtime and tooling trade-offs.                                                      |
| [Swarm testing](../history/arch-poc/swarm/README.md)                             | Measured and dropped for these workloads        | Seed-level measurements and detection rates across 19 planted bugs. Two other candidates revealed gaps in the sampled world.                 |
| [The full listener in TypeScript/Effect, Rust and Zig](listener/README.md)       | Construction; maintenance comparison registered | Same behavior contract, independent implementations and a common correctness gate.                                                           |
| Cross-platform use of the same core                                              | Open question                                   | Browser/WASM, native desktop and mobile host integration, JS host support and performance-sensitive workloads each need direct measurements. |

The existing TypeScript subject, production entry point and simulator retain their normal paths in src/. Native implementations live under listener/implementations. The task hub has a separate contract and stays outside the language comparison. The historical plan is a dated record; new study amendments and results live beside the relevant experiment.
