# Native Agent Runtime

Native Varin conversations run in the Rust `varin-runtime` crate, with Thread, HistoryBranch, Run, Request, ModelStep, Operation, Wait, queues, and usage persisted in `Catalog` (`conversation.sqlite`) + immutable `ContentStore`. Application Host handles auth, model accounts, resources, MCP, and extensions; `varin-kernel` connects the runtime to Storage, processes, compute, and Host bridges. External harnesses keep their own loops while storing bindings/observations in the same Catalog ([external-agents.md](external-agents.md)).

Authoritative schema & code: [kernel/protocol/schema.json](../kernel/protocol/schema.json) · [varin-runtime/README.md](../kernel/crates/varin-runtime/README.md) · [catalog.rs](../kernel/crates/varin-runtime/src/catalog.rs) · [execution.rs](../kernel/crates/varin-runtime/src/execution.rs) · [supervisor.rs](../kernel/crates/varin-runtime/src/supervisor.rs) · [run_assembly.rs](../kernel/crates/varin-kernel/src/run_assembly.rs).

## Core Identities & Single Writer

- **Thread**: Durable conversation/work identity. **HistoryBranch**: Ancestor chain + head (only one active history committer per branch). **Run**: One admitted execution on a branch. **ModelStep**: One provider exchange. **ToolCall**: Model invocation. **Operation**: Real work whose lifetime (`call` / `Run` / `Thread` / `environment`) can outlive the tool return. **Source**: Resource view + Host owner.
- **Durability**: `Catalog` uses an exclusive writer lock, SQLite WAL + `synchronous=NORMAL`, and short transactions. Content bytes flush to `ContentStore` before referencing metadata commits; publication leases guard in-flight objects against concurrent GC.
- **Upgrades**: Handled transactionally on open in [catalog_upgrade.rs](../kernel/crates/varin-runtime/src/catalog_upgrade.rs); unknown/newer/corrupt stores fail closed read-only.
- **Conversation organization**: Lives in Catalog partitioned by authenticated principal (containers, ordering, local revisions, retired dissolved IDs). Does not duplicate chat history, archive state, or Host Settings projects.

## Pluggable Run Drivers (`varin.agent.driver@1`)

- `RunSupervisor` invokes the frozen `RunDriver` for each admitted Run: `DefaultRunDriver` runs the built-in Rust `ExecutionEngine` (`policy@4`); `varin.agent.driver@1` lets a trusted Host extension orchestrate parallel models, dynamic tools, custom context, and delivery directly.
- Selected via Settings → Extensions → Services (scoped per user/workspace; installing never auto-selects; changes apply only to new Runs).
- Host scopes callbacks to `(Run, kernel epoch, instance)` — extensions cannot pass foreign IDs in JSON to gain authority.
- Primitives: `model` (parallelizable by stable ID), `tool` (runs through real `InvocationRunner`/permissions/idempotency; `JobAccepted` is final for async tools), `context` (drains Inbox & recompiles instructions/tools), `wait` (event-driven cursor wait on Run facts), `cancel`, `receipt`, `deliver` (publishes visible output), `checkpoint`, and `finish` (atomic Catalog completion; returns `input_pending` / `work_pending` if new work arrived).
- Recovery declares `none` or exact-schema `checkpoint` with an explicit `resume` callback (never reruns `run` as `resume`). Example: [parallel-driver](../examples/extensions/parallel-driver/README.md).

## Admission, Queues, Retry & Deletion

- **Idempotent admission**: Inputs commit with `(commandKey, branch preconditions, frozen config)`. Same-key retries return the original receipt; queued inputs keep their frozen config/revision.
- **"Send now"**: Atomically moves a queued next-turn message into the active Run and cancels an unstarted successor Run without interrupting in-flight generation/tools; delivers at the next closed model-request boundary.
- **Model retry** ([model_retry.rs](../kernel/crates/varin-runtime/src/model_retry.rs)): Configured host-wide under Conversation Defaults (`enabled`, `maxRetries`, backoff, ordered status/code/message rules; `/api/models/retry/test` evaluates drafts via `runtime.retry.evaluate`). Server `Retry-After` acts as a floor. Conversation/compaction retries create new `ModelStep`s without re-running finished tools; auxiliary inference records attempts on the original Operation. Stop cancels retry waits immediately.
- **Auxiliary runs** (titles, commit messages, PR descriptions, next-step suggestions): Independent native Runs without inventing conversation branches. Auto-title ([thread-titles.ts](../packages/web/application-host/lib/model-text/thread-titles.ts)) names after first turn and re-evaluates at configured intervals (default 5 turns); manual rename freezes auto-naming until explicitly restored.
- **Connection diagnostics**: HTTP send and response-body read errors carry a sanitized `transport_cause`. For conversation runs, each `model_outputs` row references the stored `record.failure` for that request, including retries. A clean EOF before a required terminal event has its own failure message. Chat displays the run-level summary, and retry rules match the original code and message.
- **Thread deletion**: Hides Thread and schedules reclamation once active Runs/executors settle and settle billing. Shared history referenced by surviving branches/children stays pinned; compact creation/identity/schedule-dedup records remain so retries never re-trigger deleted work.

## Reads and Observation

- **Dedicated read connection** ([catalog_reads.rs](../kernel/crates/varin-runtime/src/catalog_reads.rs), [agent_catalog_reads.rs](../kernel/crates/varin-kernel/src/agent_catalog_reads.rs)): Read-only WAL snapshots outside the writer lock (bodies read under content leases).
- **Composite views**: [catalog_thread_view.rs](../kernel/crates/varin-runtime/src/catalog_thread_view.rs) returns history window (`afterHeadId` incremental append), queues, Operations, context, children, Goals, `modelActivity`, and event cursor in one snapshot. [catalog_context_inspection.rs](../kernel/crates/varin-runtime/src/catalog_context_inspection.rs) serves context breakdown directly from Rust.
- **Event fan-out**: Durable events carry explicit `(thread_id, branch_id)` ([catalog_event_scope.rs](../kernel/crates/varin-runtime/src/catalog_event_scope.rs)). Host [event-hub.ts](../packages/web/application-host/lib/kernel/event-hub.ts) shares one native reader while tracking per-observer cursor/principal/interest. Client [thread-observation.ts](../packages/application-client/src/thread-observation.ts) multiplexes per Host and resyncs on subscribe/reconnect/gaps.

## Tools, Disclosure, Capacity & Execution Receipts

- **Work focus & disclosure** ([tool_disclosure.rs](../kernel/crates/varin-runtime/src/tool_disclosure.rs)): `general` / `code` / `research` / `office` decide which tools are directly declared in `direct_tools` (no hidden mode prompt injected). Full executable directory stays accessible via `tool_describe` (browse/search/op-specific schemas, never mutating the active function list) and `tool_invoke`. MCP keeps its own `direct` / `deferred` / `codemode` / `hidden` controls ([MCP.md](../packages/web/application-host/lib/kernel/MCP.md)).
- **Output projection & budgets**: Raw `OutputBody.data` stays intact; owners may attach `model_data`. Long outputs budget under `harness.output.visibleBytes` (preserving JSON structure/errors/cursors + `outputPreview` pointers readable via `read_thread({ kind: "output" })`). Explicit `file_read`/`process_read`/`read_thread` pages are never double-truncated.
- **Typed short refs**: `file:`, `proc:`, `env:`, `material:`, `page:`, `obs:`, `item:` map via Catalog's ref index to immutable owners/versions without string-scanning prose or expanding permissions.
- **Resource & compute admission** ([resource_admission.rs](../kernel/crates/varin-runtime/src/resource_admission.rs)): Acquires full resource plan + `configured_compute_capacity` (default `min(cores, 2)`, override `VARIN_COMPUTE_CONCURRENCY`) atomically; non-conflicting work bypasses blocked queues. Linux research probes read cgroup v1/v2 limits (`VARIN_RESEARCH_RESERVE_CPU_CORES`, `VARIN_RESEARCH_RESERVE_MEMORY_MB`).
- **Operation receipts & cancellation**: Track phase, outcome, effect (`none` | `dispatched` | `partial` | `confirmed` | `unknown`), and confirmed `executor_stopped` separately. Cancel writes intent first, then drains owners. Unknown dispatched work is never auto-replayed on restart; explicit foreground cancel can settle a Run while leaving the underlying Operation/occupation open for late reconciliation.
- **Script admission**: A missing Source or fixed revision does not activate a physical evaluator
  provider or inspect its Node/worker binding, except that an ordinary native Run may advertise
  the built-in script tools for its saved canonical local default. Its first `script_open` obtains
  the current directory instructions before process admission and may return a revision to include
  in a new call. Only after that confirmation is the original live Source stored on the environment
  Operation and the actual worker binding resolved. Cells and close retain that environment’s own
  binding; selecting another work location does not move the heap. Managed dormant defaults,
  aliases, nested opens and alternate script locations remain unsupported.
  An admitted physical Run retains its selected evaluator;
  open rechecks the captured Source and evaluator before requesting process authority. A lost
  open acknowledgement keeps the original Operation pending instead of spawning another heap.
- **Script nested calls**: Reuse frozen `ToolDirectory`, permissions, and resource admission; `script_run.title` labels the collapsible tree of nested Operations in UI.

## Context Preparation & Compaction

- **Timestamp injection**: Opt-in ("Time info" in Context settings, off by default); attached adjacent to each user message so system prompt prefixes stay stable.
- **Environment observations**: Committed Documents edits, user terminal OSC completions, and Git status snapshots commit directly to Catalog/ContentStore (bypassing Knowledge), budgeted into requests without blocking or triggering extra paid turns.
- **Compaction** ([context_job.rs](../kernel/crates/varin-runtime/src/context_job.rs), [context-compaction.ts](../packages/web/application-host/lib/kernel/context-compaction.ts)):
  - Triggered by `varin.context.budget@1` (`compaction.reserveRatio`, background prep ahead of threshold; hard `context-wait` only when next request exceeds budget).
  - Configured under Agents → Context Compaction (`harness.models.contextCompaction`, default inherits session model). Supports `varin.context.compaction@1` custom DAGs (independent DAG nodes run in parallel).
  - Model generates summary + `retain` list of original message-group refs (budgeted with local tokenizers, [models/DOCUMENTATION.md](../packages/web/application-host/lib/models/DOCUMENTATION.md#tokenizer-metadata-and-cache)); read-only `summary_read` lets compaction inspect history/tasks/records.
  - Publishes atomically with checkpoint/memory CAS while preserving messages arrived during background prep.
- **History navigation**: Explicit rewind/branch commits head CAS and preserves the previous head as a surviving `HistoryBranch` sharing immutable history (`runtime.thread.tree` serves the merged branch tree).

## Waits, Follow-Ups & Long-Lived Event Watches

- **Durable Wait**: Suspends a Run on a concrete subject (question, child, process/Job, reply, context-ready) with event cursor + optional deadline.
- **Follow-ups**: Conditional continuations (time, process/Job stop, file `exists`/`changed`/`ready`, research artifacts/metrics, Any/All).
- **Long-lived event watches** ([catalog_followup_events.rs](../kernel/crates/varin-runtime/src/catalog_followup_events.rs), [catalog_followup_event_transport.rs](../kernel/crates/varin-runtime/src/catalog_followup_event_transport.rs), [event-sources.ts](../packages/web/application-host/lib/extensions/event-sources.ts)):
  - Stored in Catalog `followups` without requiring an active `source_run_id`. Shared plugin connections keep one event ledger; each watch maintains its own match cursor.
  - Events persist bodies/files in ContentStore and commit metadata before ACKing the plugin. Supports replaceable state snapshots (`state: { key, sequence, value }`), batching, Calendar-aligned delivery, passive queuing, cross-Host authenticated consumers, and echo suppression tied to confirmed local Operations.
- **Schedules**: Project Markdown schedules run on the Source's asset Host ([managed-schedule-service.ts](../packages/web/application-host/lib/kernel/managed-schedule-service.ts), [schedule_reconciliation.rs](../kernel/crates/varin-kernel/src/schedule_reconciliation.rs)) with begin-fence before callback dispatch.

## Providers, Usage Ledger & Image Tools

- **Providers & Auth**: Native adapters ([providers/README.md](../kernel/crates/varin-runtime/src/providers/README.md), [AUTH.md](../kernel/crates/varin-runtime/src/providers/AUTH.md)) resolve secrets via Host [models](../packages/web/application-host/lib/models/DOCUMENTATION.md) right before dispatch; secrets never enter snapshots, history, or events. Custom extension protocols (`varin.models@1`) pin exact `adapterIdentity` + `adapterBindingId`.
- **Usage ledger**: `runtime.usage.summary` reads content-free per-request billing records frozen at dispatch (retained after conversation deletion; priced from custom or models.dev snapshots in USD; pushed via `usage.updated`). External harnesses report their own turn/cumulative stats separately.
- **Image tools** ([image-runtime.ts](../packages/web/application-host/lib/kernel/image-runtime.ts)): `image_generate` and `image_edit` bind explicitly configured image models (never implicitly inheriting chat models), store outputs as media resources, and preserve raw provider usage units.

## Host activity and parking

An authenticated Host owner can read the content-free activity projection at
`GET /api/system/lifecycle`; an embedding supervisor can read the same facts
from `getHostActivity()`. The read remains available during drain. It reports
Catalog admission counts, Calendar preparation and pending delivery, the next
projected Calendar wake, Calendar asset watchers, HTTP observations and active
external ingress. An unavailable owner is reported separately from a known
zero. This is an observation, not an atomic handoff receipt or permission to stop.

The Host stays online. Follow-up, timed waits, other owner retention and external
wake acknowledgement are not covered by this projection; parking remains
unsupported. Do not use the cancelling shutdown API to implement an idle park.
The durable ingress and wake protocol must first prove that accepted input and
scheduler responsibility survive a stopped Host.

### Opt-in local supervisor handoff (POSIX)

`VARIN_LOCAL_SUPERVISOR=1` enables a filesystem inbox at
`$VARIN_DATA_DIR/supervisor-wake`. The journal is private to the Host OS account;
there is no new network ingress. A built Host includes
`server/lib/lifecycle/local-supervisor.js` for a separately managed local
supervisor to run under that same account:

- `node local-supervisor.js DIRECTORY OWNER status` reports the current wake
  revision and whether accepted input is pending. `OWNER` is the original stable
  Host identity stored in the journal's private `owner.json`.
- `publish REVISION AT_MS` records the original wake owner's monotonic revision
  and chosen time, or `publish REVISION none` for a newer cancellation.
  Do not synthesize a revision from a polled projection.
- `wake-due REVISION -- EXECUTABLE ARG...` reconciles a due registration and
  writes a ready receipt only when the supplied readiness command succeeds and
  the revision is still current. The outer supervisor supplies the timer and
  an idempotent command that waits for the same logical Host's readiness.
  `wait-due REVISION -- EXECUTABLE ARG...` can instead wait on that absolute
  deadline locally. It returns stale if the registration is superseded and
  checks long deadlines in bounded intervals rather than scheduling one timer.
- `node local-supervisor.js DATA_DIR/supervisor-wake OWNER run` is the opt-in
  resident foreground process for an already initialized Host. Run just one
  supervisor for this original state directory; stop the direct Host first.
  It launches the same built Host separately on loopback (honoring `VARIN_PORT`),
  checks startup using the spawned process's private IPC and live kernel readiness,
  and reconciles wake receipts and pending inbox work. The supervisor, not its
  child, is what your service manager should stop and restart. Explicit stop
  forwards the ordinary Host drain; an unrequested child exit, even exit 0, is
  restarted with bounded backoff, not treated as Park. Losing the supervisor's
  IPC makes a supervised Host drain rather than relaunch itself.
- `accept PAGE_KEY < page.json` fsyncs an original Catalog event page before
  returning an acceptance receipt. `wake-inbox -- EXECUTABLE ARG...` lets the
  supervisor start or reconcile the original Host when accepted input is waiting.

The supervisor must already own the selected event feed and supply its original
authenticated Catalog source identity, event IDs and expected/next cursors.
Do not run another producer for the same cursor. Host replay passes the page
through the original Catalog event-receive command (including its active-source
and deduplication checks), and verifies the returned identity and checkpoint.
Conflicts or invalid acknowledgements leave the accepted page pending. The
journal keeps an acknowledged copy privately because ordinary Catalog WAL
receipts do not promise power-loss durability. This increment has no automatic
archive compaction or recovery from a storage rollback; budget disk space and
keep this directory private. On a process crash before acknowledgement, the
same pending page is delivered again under its original keys.

This does **not** switch automatic parking on or transfer Calendar scheduling.
There is no Park command and the production Host does not emit a quiescent
exit receipt. The resident supervisor must not turn an ordinary exit or stop
into Park. Incomplete owner coverage, external scheduler publication and
lossless close are still blockers. On filesystems without supported directory
sync or on Windows, do not enable the local supervisor journal.

## Graceful Shutdown & Cold Backup

- Host shutdown immediately enters `draining` (revoking readiness and rejecting new executions while allowing reads, cancels, and receipt cleanup) under a single monotonic `VARIN_SHUTDOWN_TIMEOUT_MS` deadline (default 10s; exit code 143 on graceful SIGTERM, 1 on incomplete drain without closing active DB writers early).
- Cold backup preserves WAL, ContentStore, and identities with startup fencing enabled by default on restored copies ([ops/cold-backup.md](ops/cold-backup.md)).
- On restart, prepared-but-undispatched requests may proceed; dispatched requests with unknown outcomes never auto-replay.
