# Run records

Records of how the language comparison was actually run. Failures are kept next to successes. A correction is appended with its reason, and the record it replaces stays.

- **[construction/dispatch.json](construction/dispatch.json)** records how the two ports were started: the launcher, model and settings, both prompts with their SHA-256 digests, the shared start commit, and the owner's later clarification that shared build caching is out of scope.
- **construction/rust/** and **construction/zig/** hold each builder's ledger: every command, its result, the failed attempts and the gaps. They arrive with the ports. A construction ledger is the builder's own account. It is not acceptance evidence.
- **maintenance/** will hold the scored trial: the sealed registration (prompts, held-back checks and scoring code, with their digests), then the evaluator's ledger and receipts. It stays empty until the common baseline gate passes ([what has to happen first](../README.md#what-has-to-happen-before-the-scored-trial)).
