# Performance: Costs, Boundaries & Measurement

Measure changes by user-perceived outcomes: streaming smoothness, action responsiveness, correctness, multi-device consistency, and disconnect recovery. Synthetic speedups do not equate to lower model latency, better provider caching, or faster packaged startup.

## Costs and Boundaries

- **Cross-process IPC**: Every Host ↔ Rust call is a cross-process round trip. Calling it inside a loop turns one view into dozens of round trips (`Promise.all` does not turn per-item IPC into a batch query when the peer serializes work).
- **Disk & SQLite**: File locks, `fsync`, and full-file rewrites cost milliseconds (more on Windows). A single SQLite writer, single actor thread, or tight request window serializes everything behind it.
- **Observer fan-out**: One event fanned out to N observers multiplies each observer's work by N — avoid "refetch everything on any event" observers.
- **Validate at real trust boundaries**: Validate at renderer/remote HTTP entry, extension/broker boundaries, provider/network responses, and external process output. Do not duplicate generic shape checks across the typed, authenticated same-build Host ↔ Rust wire or in-process calls.
- **Cache immutable & single-writer facts**:
  - Immutable ownership (Thread → principal; Run/Operation/Input → Thread) can be cached in-process.
  - Single-writer data (principals, paired clients) can stay resident in memory and update on write rather than lock-reading disk per request.
  - Externally editable config files (`settings.json`, etc.) check file signatures before reusing cached parsed bodies.
- **Durability**: WAL + `synchronous=NORMAL` prevents corruption and dangling references as long as content bytes flush before the referencing metadata commits.
- **Short critical sections**: Keep Catalog/Storage locks brief; run large body reads, compute, and materialization outside writer locks while retaining leases/cancellation.
- **Delete redundant defense**: Checks that protect against no real untrusted input or failure mode add latency without safety. Remove them together with tests that only exist to assert them.

## Key Implementation Entrypoints

- Auth & settings caching: [ui-auth](../packages/web/application-host/lib/ui-auth/DOCUMENTATION.md), [settings-store](../packages/settings-store/DOCUMENTATION.md)
- Rust composite reads & transport scheduling: [varin-runtime](../kernel/crates/varin-runtime/README.md), [kernel transport](../kernel/README.md#transport-lifetime)
- Client observation bus & streaming projections: [application-client](../packages/application-client/README.md), [UI stores](../packages/ui/src/stores/DOCUMENTATION.md)

## Measurement

### Catalog and Host memory

- Recovery selects unfinished work, retained ownership and pending receipt repairs through SQLite indexes. It captures their row IDs inside the recovery transaction and reads each body immediately before processing it. A child receipt can settle another selected operation in the same transaction.
- Prepared context transforms belong to the Run compiler. Each Catalog reader keeps its most recent branch inspection and streams the ancestry metadata needed for a cache miss. Both can reconstruct their views from the durable checkpoint.
- An external Agent connection's idle check reads whether the conversation has turns, unfinished work or an outstanding child report. Fetching conversation history for this timer would allocate item bodies on both sides of the Host/kernel connection.
- External Agent startup looks up conversations through the open-turn index. Draining the queue reads the first eligible turn and its conversation metadata. Finished turns and transcript bodies do not participate in queue discovery.
- Kernel transport codecs and Catalog content readers create blocking workers when jobs arrive and retire idle workers. To measure this, sample native thread count before any file work, during a large transfer, and after the worker keep-alive.
- While a model stream is quiet, worker maintenance can reap completed work. Durable notifications are sent for committed changes and executor ownership transitions. Count notifications during a held local provider response to measure the resulting Host activity.
- Knowledge vector reconciliation follows the global embedding selection and the installed local embedding component. Editing a desktop preference does not invalidate the registered knowledge indexes.
- The model directory owns its parsed source data. Its one-time disk load bypasses the shared settings text cache, and atomic replacements invalidate old cached text.

For a Linux memory report, record the kernel and Host PIDs across startup, active execution and idle after completion. Compare `VmRSS`, `RssAnon` and `RssFile` in each PID's `/proc/<pid>/status`, alongside the container's `anon` and `file` values in `memory.stat`. Record active work and retained history size with each sample. Repeating the same work on the same processes distinguishes a growing idle footprint from a restart peak.

### Workload comparisons

Compare identical workloads on the same build type while verifying correctness. Prefer deterministic work counts (IPC calls, snapshot reads, renders) for regression tests; record cold/warm, platform, and sample counts when reporting wall-clock numbers.

For a long chat with tools, measure timeline projection separately from layout and paint. All turns in a projection share the descendant index for that execution snapshot. Verify that the resulting rows and their order agree when comparing implementations.

```sh
node --import tsx scripts/measure-document-registry.mjs
node --import tsx scripts/measure-interaction-hotpaths.mjs /path/to/checkout artifacts/performance/host.json
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --lib measure_catalog_read_hotpaths -- --ignored --nocapture
node --import tsx packages/web/scripts/perf-knowledge-recall.ts 1000 8 2048 engine
node --import tsx packages/web/scripts/perf-knowledge-recall.ts 1000 8 2048 ipc
```

- [measure-interaction-hotpaths.mjs](../scripts/measure-interaction-hotpaths.mjs): Host Documents file-op counts, UI embed/layout counts, and snapshot counts (uses portable fixtures — not full durable save/server latency).
- [measure-kernel.mjs](../scripts/measure-kernel.mjs): `--compute-hotpaths` against a staged release kernel.
- Browser profiling: [scripts/profile-browser.md](../scripts/profile-browser.md).

### Built-in preparation and process memory

From a built runtime workspace, run `node --expose-gc --import tsx packages/web/scripts/measure-builtin-preparation.mts --bots=2`.
Repeat with `--legacy` in a fresh process for the forwarding-broker control. Both variants exercise
the actual artifact store, service routing, directory, context and lease owners. They do not call a
model. Each line separates elapsed directory preparation, newly launched brokers and a settled
sample while tool leases are held. Linux uses private resident pages from smaps rollups.
Windows uses private committed bytes for the same processes. The native HTTP context-composition
suite covers the separate client-to-model boundary; directory timing is not first-token latency.

A Linux two-Bot run (56 tools per Bot, no workspace, no model, one cold/warm pair per mode)
took 6.14/4.91 s in the original forwarding backend and 3.15/2.47 s with direct Host handlers.
Brokers started went from 12/11 to 0/0. With leases held after preparation, Host plus broker private
memory was 555/580 MiB versus 267/274 MiB. These samples use the same checkout, not a comparison
with the Windows installer or a guarantee for other hardware and plugin selections.

On Windows x64 the two-Bot control started 12/11 forwarding processes on cold/warm preparation,
while direct dispatch started zero in both rounds. With 56 tools per Bot, preparation took
7.95/6.35 s and 3.14/3.04 s respectively. Host plus live broker private committed memory was
620/622 MiB in the control and 267/269 MiB with direct dispatch (one cold/warm pair per mode).

Local semantic preparation loads the tokenizer without acquiring ONNX. Actual inference acquires a
worker shared across concurrent requests; the last physically settled request starts an idle grace
based on observed reload cost and estimated process RSS growth. Reacquisition keeps the same model
and tokenizer. For deployment measurements separate the Host-wide RSS estimate from model weights
and sample the first inference again after worker exit.
