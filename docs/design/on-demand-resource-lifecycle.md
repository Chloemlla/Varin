# On-demand resources for Bots and Agent execution

Design proposal, 2026-11-25. Source baseline `0581422ca439d75c85b8aaf45b18ed4b63b29720`.

Implemented: [dormant native defaults, scoped child file access and on-demand scripts on the original local directory](../../packages/web/application-host/lib/kernel/THREADS.md#dormant-launch-work-locations), passive Browser/Computer discovery and selected activation, worker/connection retention, independently locked [File, Browser and Computer roles](../ops/cloud-deployment.md), authenticated Host activity and an opt-in [resident local supervisor](../runtime.md#opt-in-local-supervisor-handoff-posix). Existing explicit project/native workspace preparation remains when needed to capture admitted context. The local supervisor accepts declared Catalog event pages, not arbitrary HTTP writes, and does not enable automatic Host parking. Applying these guarantees to managed dormant script directories and native workspace retirement requires the corresponding owners' bindings.

This proposal covers the open-source runtime, resource owners, clients and distribution. It follows the [resource optimization work](resource-optimization.md) and prepares reusable integration points for a separately operated hosted product. The behavior below is proposed unless identified as current implementation. Startup latency, retained memory and idle policy values require measurements on the resulting implementation.

## Intended behavior

A Bot has a durable identity, conversations, memory, instructions and ongoing responsibilities. An individual conversation can use models, attachments, services, browsers, computers and files without selecting a project. Resources become active when an admitted operation needs them. Their physical lifetime follows the work that uses them.

The primary experience is a Bot conversation. The same resource behavior applies to ordinary Agent conversations, groups, delegated work, scripts and background wakes. A group message wakes only its addressed/listening members through the existing delivery mechanism. Membership alone carries no execution-resource demand.

| Interaction | Required work |
| --- | --- |
| Open a conversation, switch Bots, select a saved device or project | Read identity, history, settings and saved resource metadata. |
| Send a message | Prepare the actual model request, its instructions, attachments and configured recall. |
| Read an uploaded document | Read its retained attachment and activate the decoder/rendering service required by that document. |
| Ask a Bot to inspect files on a device | Resolve that operation's device and path, acquire its file access and return the result. |
| Start a command | Acquire the execution environment and retain it for the command's actual lifetime. |
| Use a website | Acquire the selected browser and the relevant page/session. |
| Use a desktop application | Acquire the selected computer session and its existing observation or input authority. |
| Wait until tomorrow or wait for an external event | Persist the continuation and retain the listener or wake delivery needed for that condition. |

Pure conversation has no mandatory file/process Source. Configured memory recall can still require storage or local inference. Explicitly opening a live file, preview, terminal, browser page or desktop viewer constitutes real resource use.

## Current implementation and changes required

| Area | Verified implementation | Design consequence |
| --- | --- | --- |
| Bot identity | Bot profiles, home directories, memory and schedules outlive Threads. Execution belongs to the ordinary runtime. | Reuse the existing Bot and Catalog owners. Automatic resource retirement leaves the Bot available for new work. |
| Native input | `ThreadAdapter.submit` and cold-work preparation resolve a Source before context/launch preparation. Fresh Bot conversations can prepare `bot.homeDir` through `createConversationWorkLocation`. | Separate the default file location from preparing physical access. Apply the change to foreground and background entry points together. |
| Native tool assembly | Source-less launches admit the attachment form of `file_read`. Most native file/process tools require a prepared Source. Dynamic work-location tools currently require a root `live_root` Run. | Change tool declaration and dispatch together so a fresh Bot can discover and use devices without acquiring a dummy local Source. |
| Context | Source, captured instructions, skills, project settings and composition share preparation paths. | Preserve the actual instruction/configuration scope while deferring execution-environment acquisition. |
| Resource nodes | `resource-node.ts` runs the kernel's resource role with a durable Host identity. It serves live files and commands and accepts `live_root`. | Use this as the first independent execution role. Native workspace backends and Browser/Computer hosting need explicit additional assembly. |
| Browser | `BrowserResources` separates resource, instance and page identity and owns page write lanes/takeover. Discovery calls refresh providers. CDP connects to an existing browser endpoint. | Introduce cheap saved descriptions and optional managed activation at the provider boundary. Retain existing page authority and file transfer. |
| Computer | Native drivers start on acquisition. `ComputerService.list` initializes records, refreshes peers and performs its first local capability probe. Shared macOS/Wayland sessions retain platform authorization. | Separate directory display from active probing. Release capture, input and platform-session resources according to their own lifetimes. |
| MCP and external harnesses | MCP already has scoped shared instances, offline directories and holder-based retention. External agents reclaim resumable idle connections and retain non-resumable sessions. | Extend these existing owners with accurate activity reporting and use their established reconnect semantics. |
| Local workers | Embedding inference loads on actual inference, shares concurrent requests and retires after settlement and an adaptive idle period. Knowledge storage has a single private process owner. | Build on these implementations and audit consumer retention, worker startup and expensive imports. |
| Bot sleep and Host shutdown | Bot sleep stops admission and drains work. Host shutdown rejects new executions and drains owners. Catalog owns durable waits, schedules and events. | Add infrastructure idleness and wake handoff alongside existing product controls. |

Decisive code paths are [default work location](../../packages/web/application-host/lib/kernel/default-work-location.ts), [ThreadAdapter](../../packages/web/application-host/lib/kernel/thread-adapter.ts), [native assembly](../../kernel/crates/varin-kernel/src/run_assembly.rs), [work-location routing](../../kernel/crates/varin-kernel/src/work_locations.rs), [model work locations](../../packages/web/application-host/lib/kernel/model-work-locations.ts), [context preparation](../../packages/web/application-host/lib/kernel/thread-context.ts), [BrowserResources](../../packages/web/application-host/lib/browser/browser-resources.ts), [ComputerService](../../packages/web/application-host/lib/computer/computer-service.ts), [MCP authority](../../packages/web/application-host/lib/mcp/DOCUMENTATION.md), [external connection retirement](../../packages/web/application-host/lib/external-agents/service.ts), [local embedding](../../packages/web/application-host/lib/knowledge/semantic/local-embedder.ts) and [Bot lifecycle](../../packages/web/application-host/lib/bots/bot-lifecycle-runtime.ts).

## Ownership and lifetime

Keep each existing domain responsible for its state. Catalog owns accepted work, context and operation receipts. Storage owns file leases, revisions, mounts and processes. Browser and Computer owners retain their page/control/session authority. Host services own configuration, credentials and protocol connections.

Three concepts need independent representation in these existing contracts.

| Concept | Contents and lifetime |
| --- | --- |
| Saved selection and permitted capabilities | Stable owner/resource identity, optional default location, configured capabilities and existing permission scope. Survives conversation completion and disconnection. |
| Execution binding | The instance, directory/view, credential scope and instruction/configuration revision actually used by an operation. Recorded with the original operation and retained while it is needed for work or reconciliation. |
| Runtime handle | A connection, worker, loaded model, mount, browser process or platform session. Retained by its real consumers and released through its owning service. |

Every physical resource exposes enough owner facts to explain active use, pending startup, retention for live session state, draining and an optional warm-retention deadline. These facts are projections of existing leases, operations and session owners. Lifecycle decisions belong at those owners. A Host-level view aggregates their reasons and next wake requirement.

A completed operation may still need its result, provenance or recovery files for years. Those durable references retain data. Physical mounts and workers are retained only where continued execution, a live session or reconciliation actually needs them. In particular, an unknown historical effect whose executor has confirmed stopping can retain its receipt without keeping an otherwise unused worker alive.

Compatible consumers can share physical resources. Compatibility includes the actual owner, account/profile, configuration generation and isolation requirement. Browser pages retain their per-page write lanes, desktop input retains its single-controller rule, and file writers retain native file coordination. A Bot ID or a conversation ID alone is insufficient to choose the sharing scope.

## Message and tool execution

### First model request

1. Resolve the authenticated input, Bot/Thread model preference and existing admission key. Persist and recover acceptance through the current Catalog path.
2. Build context from the admitted Bot/global instructions, committed conversation state, requested attachments and configured recall. Capture explicit project/skill dependencies according to the context rules below.
3. Describe configured capabilities and saved resource selections using metadata. Capability declarations distinguish configuration and last-observed availability from a live instance.
4. Submit the model request. Activate an execution resource when a model tool, background operation or explicit user interaction actually needs it.

No prompt classifier is needed to guess whether a message is “chat” or “work.” Actual operations identify their dependencies. Native capability schemas are available from the shipped definitions. MCP uses its existing cached-directory and discovery behavior, including an explicit discovery connection when required metadata has never been obtained.

Registration should remain inexpensive. A Host can register routes and capability descriptors at startup while deferring expensive imports, native libraries, subprocesses and environment probes to their executing owner. Confirm actual spawn/load work before moving constructors. The Host's existing kernel, admission, receipt recovery and event infrastructure remain the foundation for handling messages.

### First resource use

The existing invocation path performs resource preparation under the original Operation.

1. Resolve the selected logical target under the caller's admitted authority. A call may use a default, an explicit discovered device/location, an attachment reference, or an existing process/page reference.
2. Join any compatible in-progress acquisition. Preparation is owned by the resource owner, with separate waiters for each consumer.
3. Acquire the real connection/environment, obtain the current resource view and required context, and bind the operation to that concrete instance.
4. Publish any newly required instructions or tool declarations at the model boundary described below. Dispatch uses the existing permission, invocation and receipt owners.
5. Release the call's use when the actual work settles. Long-running work retains its own operation/session use before the call returns.

Preparation is cancellable before dispatch. Cancelling one waiter detaches that waiter while other consumers continue. When the last waiter cancels during an asynchronous remote create/bind, the owner accounts for its eventual completion and releases any returned allocation. A lost response is reconciled by the existing operation identity. Resource startup coalescing and invocation idempotency solve different races and remain at their respective owners.

Model requests keep their published tool definitions. Late binding resolves where an already permitted capability executes. New provider declarations or changed schemas enter through the next normal composition boundary. An operation already dispatched keeps its original binding and receipt until settlement.

### Contract changes and existing data

Extend the current protocol and storage owners at these boundaries. The names below identify the records to change, with generated wire types updated from the kernel schema.

| Existing record or boundary | Required representation |
| --- | --- |
| Thread/branch defaults and creation settings | A saved logical resource selection, including the distinction between an inherited default, an explicit choice and explicitly disabled access. Resolving a default yields a descriptor. |
| `LaunchSelection` and delegated launch scope | The resource capabilities admitted for this work and its selected default, independently of a currently acquired Source. The scope is derived from the existing principal, configuration and delegation owners. |
| `ContextCheckpoint` | The instruction/configuration snapshots actually used, their original source/version and any unresolved optional project context. |
| Operation resource binding and receipt | The concrete target instance, Source/view, execution environment and original effect/stop evidence needed by that operation. |
| Browser/Computer discovery | Configured identity, supported capabilities, last-observed availability and the owner's supported activation behavior. |
| Host lifecycle projection | Current use/retention reasons and next-wake information obtained from authoritative owners. |

Preserve input command keys and their accepted receipts across acquisition retries. An endpoint reconnect or physical instance restart can refresh its resource binding without changing a shipped tool schema. Tool composition identity follows the actual selected definitions and configuration, and operation identity follows the original admitted work. This distinction prevents backend replacement from recreating the old preparation/composition mismatch.

Read older defaults and launch records through their existing Source representation. Retain fixed revisions, native branch identity, permissions and unresolved receipts. New resumable work adopts lazy acquisition at its normal preparation boundary. Explicit source-less restrictions stay represented separately from a default whose instance has not yet been acquired. Capability restoration derives from the original admitted scope, including child limits. Physical grants from an exited instance are reacquired through the current owner when needed.

Apply the schema change through the existing Catalog upgrade and protocol-generation process. Cover persisted queued work, Bot schedules, external bindings and reopen-after-restart behavior in the implementation. Data inspection alone must leave offline resources dormant.

## Files, commands and instruction scope

### Default location without eager execution

Retain the current effective location precedence when deriving a default from existing data. Explicit call targets, retained process/file references, explicit conversation choices and existing source inheritance keep their meanings. A fresh Bot can derive its default file location from its home directory, subject to the deployed file authority. An ordinary conversation can use its configured default device/location. These choices become saved descriptors that require physical resolution only for actual use.

Bot identity storage, the default directory for relative tool paths and the physical execution instance become separately addressable. Bot memory, schedules and profile loading can access their storage directly. This does not acquire command execution on the Bot's home directory. Local full-access file tools still follow their existing filesystem authority. Reading an arbitrary permitted absolute path requires no project creation.

Persist the permission to resolve resources independently of whether a live Source is present. A native root conversation can expose device discovery and file/process dispatch under that authority. Child tasks receive their explicit delegated capability scope. Historical source-less restricted tasks and members without Host-resource authority retain their original permissions when opened after upgrade.

Update the TypeScript input, cold-work and source adapters together with Rust tool assembly and per-call routing. Move the physical bind from blanket Run preparation to the operations that need it. Preserve the recorded Source for historical work and explicit fixed/native views. Ordinary live-location calls and explicitly pinned branch calls resolve through their corresponding source owners.

An explicit location on one tool call applies to that operation. `work_location_switch` keeps its existing next-Run default semantics. Parallel operations use their captured targets. A background process retains its original working directory, source view and environment even when later calls use another device. External harness adapters that require a working directory obtain it when the adapter session is actually prepared.

### Project instructions and skills

Separate global/Bot context, requested project context and execution access in `ThreadResourceScope` and context preparation. Source-specific instructions, trusted project configuration, skills and MCP configuration keep their provenance and precedence. Merely navigating to a project or remembering a location can use saved metadata.

For a previously admitted project context, general discussion can use the captured instruction snapshot with its recorded version while the device is offline. The resource description reports that live contents are unavailable. A fresh optional project selection with no admitted snapshot contributes its identity and the unavailable-context fact. Explicit requests for a project skill, required project-selected model configuration or live content resolve that dependency and surface its failure at the corresponding request. The system must accurately record which context was used.

When first resource preparation discovers instructions that affect the proposed operation, publish those instructions before performing that operation. Finish the preparation attempt with a typed, non-dispatched result and continue through the existing context/model loop so the model can issue the appropriate call. An already admitted instruction snapshot with matching dependencies can proceed directly. This avoids asking a model to obey instructions it has not received.

Read-only inspection needed to obtain instructions uses the existing resource reader. Instruction lookup from a stored branch can avoid mounting it. A live-only remote resource may require connecting to its owner for these bytes. Measure that real dependency as part of first use. Applying resource laziness must preserve required project configuration, explicit skill activation and the correctness of fixed-source context.

### Native workspaces, recovery and documents

Logical branches, saved revisions and recovery points retain their data without requiring a mounted path. File operations can use the native storage interface where available. Commands and external programs acquire a physical view. Release that view after its process, document/save and recovery owners have settled.

Recovery still coordinates conversation and file history through the existing owners. Remounting a branch resolves its current registered revision, and reopening an editor goes through Documents revision validation. Active edits, save operations, recovery/undo work and process writers contribute their real lifetime. The existing source-retirement code remains responsible for historical source deletion, while physical idle unmount uses a separate operation on the same native workspace owner.

Standalone Resource Node currently serves live directories. Its native-workspace extension must supply the existing Storage and platform backend contract, including branch identity, recovery and mount release. Keep the selected source mode explicit during rollout. A requested native view becomes usable when its actual node backend supports it.

Relevant owners are [resource scope](../../packages/web/application-host/lib/kernel/thread-resource-scope.ts), [source launch](../../packages/web/application-host/lib/kernel/source-launch.ts), [native workspaces](../../packages/web/application-host/lib/kernel/native-workspaces.ts), [source retention](../../kernel/crates/varin-runtime/src/catalog_source_retention.rs) and [Documents](../../packages/web/application-host/lib/documents/DOCUMENTATION.md).

## Browser and Computer resources

### Browser

Extend provider registration to describe a configured browser independently of a connected process. Preserve `browserId` as the logical identity and `instanceId`/page references as the actual live generation. A provider can advertise whether it supports connecting, starting an owned browser, or restoring a saved profile. Listing configured resources reads those descriptions. Explicit refresh can probe availability, and opening/using a browser can invoke supported activation.

The current CDP adapter continues to attach to its configured endpoint. A managed browser provider can run beside Chromium and own startup, profile storage, byte transfer and stop. A remote profile resolves on that owner. Downloads needed by later work move into attachment or file storage before their temporary browser backing is released.

Resource use includes active actions, downloads, page ownership, user retention and takeover. An open page can hold unsaved state even while no call is active. Session retention therefore participates in idle decisions. Whole-browser shutdown is available when its owning provider can preserve the required state or the session has explicitly ended. Authentication profiles can survive reopening, while document references and element observations are recreated for a new instance.

Reuse Electron's existing user-retained tabs, hidden-page handling and Thread ownership. A plain history viewer releases only its observation. An explicitly opened browser viewer retains the displayed session. The existing Linux browser owner lets Browser and Computer interfaces address the same physical browser, carrying both kinds of use to its common owner.

### Computer

Split stored desktop discovery from `probe`, capture and input acquisition. A device settings page can display last-known capabilities with their availability. Starting a viewer acquires capture. Taking input authority or issuing an action uses the existing control lane and operating-system authorization.

Track capture users, input/automation users and platform-session retention separately. Hidden viewers stop requesting frames. Windows capture and input helpers can retire independently when their actual work and input release have settled. macOS and Wayland can retain the authorized shared session while pausing capture work, preserving the user's permission experience. Linux managed desktops and VMs have explicit environment owners that decide when the whole session can stop.

Automatic release is limited by the ownership actually granted to Varin. A user-owned physical desktop remains under its owner. Varin-created disposable sessions and exclusively managed VMs expose their lifecycle operations through the existing Computer/VM services. Shared sessions account for every remaining consumer before stop.

Reuse [browser control](../../packages/web/application-host/lib/browser/browser-resources.ts), [CDP](../../packages/web/application-host/lib/browser/CDP.md), [Linux browser sharing](../../packages/web/application-host/lib/browser/linux-browser-owner.ts), [Electron pages](../../packages/electron/browser-owner.ts), [desktop drivers](../../packages/web/application-host/lib/computer/desktop-drivers.ts) and [Computer lifecycle](../../packages/web/application-host/lib/computer/DOCUMENTATION.md).

## Other runtime consumers

| Consumer | Activation and retention design |
| --- | --- |
| Model request | Resolve the chosen account and request configuration at the existing boundary. Hold active transport, retry or cancellation work until its real settlement. Remote generation can be quiet while still active. |
| Memory and knowledge | Open the required store for actual recall, edit or maintenance. Retain its writer and outstanding transactions until committed/closed. Bot settings and directory display should use metadata without opening every Bot's store. |
| Embeddings and reranking | Reuse the current inference owner, request scheduler and adaptive worker retirement. Share compatible model generations across consumers. Model installation, tokenization, loaded weights and active inference have separate lifetimes. |
| Speech, PDF and other conversion | Activate the relevant decoder/model/worker on actual input. Use existing worker and component owners to retire expensive state after the admitted work drains. Preserve stream, file and output ownership during cancellation. |
| MCP | Reuse definition/account/Host identity, directory caches, shared instance holders, Tasks and subscriptions. Transfer a prepared composition's live retention to actual consumers where required. An undiscovered dynamic tool may require a connection to obtain its schema. |
| External agents | Retain native session identity, files and continuation state. Reclaim according to the adapter's advertised resume capability, queued turns, interactions and background jobs. History rendering can read persisted observations. Editing current protocol options may require a live connection. |
| Third-party extensions | Keep existing activation and service ownership. Long-lived event connections and plugin state contribute explicit retention. Trusted bundled dispatch continues using the direct Host handlers shipped in the preceding optimization. |
| Terminal, LSP, preview and port forwarding | An open interactive terminal or live preview has an actual consumer. Jobs survive observer closure according to their original lifetime. Release streams and reconstructible client state independently from the process or server. |
| File/event watches | Preserve the condition's required observation. A lossless external queue can allow disconnection and catch-up. Edge-triggered or local-only observation retains its listener until a supported handoff exists. |

The first implementation audits these owners and reuses their release mechanisms. The shared vocabulary describes demand and retention. Domain-specific lifecycle operations remain implemented by their existing owners. [Knowledge process](../../packages/web/application-host/lib/knowledge/store-process.ts) · [inference](../../packages/web/application-host/lib/knowledge/semantic/DOCUMENTATION.md) · [external harnesses](../external-agents.md) · [MCP](../../packages/web/application-host/lib/mcp/DOCUMENTATION.md).

## Acquisition, idle release and recovery

Owners serialize startup and retirement for the same compatible instance. A new user arriving during warm retention cancels retirement. Once physical close has begun, a successor waits for close before acquiring replacement resources that require exclusive access. Failure of one owner affects operations depending on it and leaves independent capabilities usable.

The existing operation records distinguish preparation, dispatched effects and confirmed executor stop. Resource release consumes those facts. A returned tool result can represent an accepted background job, whose ongoing work retains the environment. Conversely, a durable waiting Run may have released all local execution resources while an external event service owns its wake.

Idle retention is an owner policy based on reload cost, retained memory and useful session continuity. Start from the existing policies for embeddings, MCP, external sessions and browser pages. Add or change a value when a measured workload identifies a tradeoff. Expose a user setting where it controls a meaningful behavior such as preserving a managed desktop session. Configuration of a resource alone supplies no active-use claim.

On restart, use existing durable Operations, original bindings and service receipts to reconstruct necessary work. Runtime handles are reacquired only for work that still needs them. Unknown dispatched effects stay attached to their original receipt and reconciliation path. Confirmed old-executor termination can permit a replacement resource while its historical outcome remains recorded as unknown.

Remote ownership loss needs physical enforcement where two instances could write the same data. Extend the current owner generation and binding protocol at that boundary. For a future managed provider, successful replacement requires proof that the prior writer lost access through its execution/storage mechanism. The open-source contract carries the original identity and retirement result, and the provider implements its actual infrastructure operation.

## Host idleness and wake handoff

Resource idleness, Bot sleep and Host shutdown have different effects on work admission. Bot sleep is the user's request to suspend that Bot. Automatic idle release leaves the Bot eligible for inputs, reports and schedules. Closing a UI observation changes the observation lifetime.

Initially the Host remains available while unused execution resources retire. The later Host lifecycle extension supplies an authenticated, content-free activity view assembled from the existing owners. It reports active work, session/listener retention, pending durable delivery, the earliest required wake and the concrete reasons a Host must remain present. These are demand facts, independent of CPU utilization and the task-inactivity watchdog.

A process supervisor can request parking after installing a durable wake path. The owner follows this sequence.

1. Reserve a parking attempt against current admission and activity. Before sealing the attempt, new input can cancel parking and continue normally. After sealing, the external ingress durably accepts or queues new input for wake.
2. Publish the next required wake and external event handoff with a durable receipt. The aggregate includes Calendar, timed waits, follow-up batches, retry deadlines and pending delivery. Original schedulers keep deciding business occurrences.
3. Confirm remaining work is durably resumable and local execution/session holders have released or transferred responsibility. Persistent file watchers, live model streams, non-resumable external sessions and unsupported driver checkpoints keep the corresponding retention reason.
4. Close stores and the kernel through a graceful parking path that preserves scheduled/queued continuation intent. The existing cancelling shutdown path needs explicit review before reuse.
5. On wake, start the same logical owner, reconcile original receipts, refresh schedule assets as required, and deliver accepted inputs using their existing keys and cursors.

Wake publication and subsequent changes need recovery after a crash. Use durable publication associated with the original owner revision, with acknowledgement before voluntary parking. A supervising ingress keeps accepted events until the original Catalog acknowledges them, and reconciles any unacknowledged wake registration after restart. Stale wake notifications are checked against current schedule revisions. A shared platform scheduler can consume this contract later.

Open-source deployments can keep the Host online when they have no external wake supervisor. An ordinary sleeping Host cannot receive its own network request or run its own timer. Scheduled work and event listeners must retain a running owner until their actual delivery has been handed off.

The default Compose Application Host runs as the foreground application with a restart policy. To park it without an immediate restart, the supervised deployment must keep its ingress/supervisor resident while the Host process exits, or use a deployment policy that distinguishes a park from a crash. The Thread write owner rechecks drain admission after HTTP authentication and retains admitted work until its handler settles, including after disconnect. Parking acceptance must observe an absent Host process before wake and preserve an admitted submission not yet acknowledged by the Catalog.

This step extends [shutdown](../../packages/web/application-host/lib/shutdown-runtime.ts), [admission drain](../../packages/web/application-host/lib/draining-admission.ts), [runtime ownership](../runtime.md), [scheduled tasks](../../packages/web/application-host/lib/scheduled-tasks/DOCUMENTATION.md) and [Bot lifecycle](../../packages/web/application-host/lib/bots/bot-lifecycle-runtime.ts).

## Independent roles and distribution

Provide deployable roles with exact dependency closures and compatible versioned protocols.

| Role | Owned responsibilities | Activation scope |
| --- | --- | --- |
| Application Host and kernel | Bot/Thread state, models, context, events and orchestration | Host service, with later supervisor-assisted parking |
| File and command node | Files, process trees, native storage/recovery where supported | Explicit service or managed provider instance |
| Browser owner | Browser process/profile when managed, page operations and file transfer | Browser resource/profile |
| Computer owner | OS driver, capture/control, managed desktop/VM integration | Physical or managed desktop session |
| UI clients | Presentation, drafts, editor/viewer consumers | Client/window lifecycle |

A device may assemble several roles and share one physical browser or filesystem. Each role advertises its actual supported capabilities. Reuse the existing Host and resource-node assembly functions and extract capability-specific wiring as roles become deployable.

Each dedicated role has its own production lockfile and verifies the installed dependency graph and entrypoint. Dedicated role readiness checks control-plane liveness, not whether Chromium, a platform desktop driver or an application is presently available. Shared image layers can still contain useful common tools.

Add browser and computer role assembly from the existing services. A browser-only node carries its profile/transfer dependencies. Computer images or installers include the driver and applications required by that platform. Native file nodes include the selected FUSE/FSKit/macFUSE/WinFsp support and preserve its existing mount behavior. Full and Light Desktop keep their respective local-service and remote-client assembly.

Persist logical node identity and grants alongside their current owner state. Work files, browser profiles and service state have independently configured storage locations. Stopping and starting an instance with those volumes restores the same logical resource. A restarted browser/process gets a new live instance identity, and operations reacquire its actual handles. Health readiness means the advertised role can accept its control requests. Resource readiness is reported for the specific capability being acquired.

A future hosted provider can implement startup, placement, volume attachment and retirement behind these role owners. Its account routing, fleet sizing, billing, cloud storage and prewarmed capacity live in the deployment fork. General lifecycle, protocol and correctness changes belong upstream. Deployment releases pin an upstream revision, compatible role artifacts and state migrations, with correctness fixes backported as needed.

The first hosted composition can retain one current Catalog writer per independently managed state directory. Scaling and database sharing are separate architecture decisions. This proposal's deliverable is the runtime contract that lets a supervisor activate and retire that unit correctly. [Current images](../ops/cloud-deployment.md) · [Docker assembly](../../Dockerfile) · [Resource Node](../../packages/web/application-host/resource-node.ts).

## Client behavior and diagnosis

Use the current operation status area and resource panels. Preparing a browser or device appears on the operation that requested it. Request preparation, provider connection and first response remain distinguishable through existing model activity. Technical acquisition stages belong in expandable details where they help diagnose failure.

Resource selectors show saved devices and capability descriptions immediately, including last-known unavailable resources. An explicit refresh can update availability. Selecting a resource stores the preference. Opening its live viewer acquires the corresponding observation/session use. Reading stored history or a completed artifact can proceed without reconnecting the original executor.

For external agents, separate cached model/mode display from applying a new live option. Use the existing capability cache when opening the composer or reading a completed turn. An explicit request for uncached protocol options may prepare the adapter. This keeps the existing resume and configuration behavior discoverable while avoiding an unnecessary CLI startup just to render a label.

Offline resources fail the dependent operation with the resource identity and a useful reason. Independent conversation and other admitted tools remain available. A future managed-provider wake can appear as preparing while its existing operation waits. Stop cancels that operation's preparation through the existing cancellation path.

Keep Bot interactions usable without a project selection. Existing work-location controls serve users who choose to set a default. Group chats and delegated work project their original member/task statuses, and automatic idle resource release adds no Bot sleep toggle or extra persistent status row.

## Implementation sequence and acceptance

### 1. Bot admission and capability-driven acquisition

Refactor saved default selection, capability authorization and physical binding together. Cover `submit`, cold Bot work, queued continuation, direct and group messages, schedules, child dispatch and script-invoked tools. Publish native file/device dispatch without a mandatory initial live Source. Preserve explicit instructions, skill dependencies and fixed/native source behavior through context preparation.

Acceptance uses a real HTTP conversation with a controlled model that requests tools on later turns. Opening and chatting with a fresh Bot starts no file/process environment. The same conversation can then read a permitted device path, launch a command and read an attachment. A selected offline device can remain selected during independent discussion. A fresh project skill that needs unavailable bytes reports that dependency. A restored historical restricted task gains only its original authority.

### 2. Physical use and retirement across owners

Audit native Sources/processes, Browser, Computer, MCP, external harnesses, knowledge and inference with the lifecycle table above. Add demand reporting to the existing owners where missing. Separate metadata discovery from probes and acquisition. Apply idle retirement according to actual work and session continuity.

Acceptance covers two Bots sharing an eligible resource, one cancelling during shared startup, a last waiter cancelling before a remote startup reply, a new caller arriving during close, a background process surviving page closure, and last-consumer release. Exercise browser downloads/takeover and retained pages, Windows independent helpers, and macOS/Wayland shared-session authorization on their actual platforms. A completed call cannot release a live job's environment. An old unknown receipt with a confirmed stopped executor does not pin a worker indefinitely.

### 3. Role packaging and restart continuity

Produce the lean file/command-node closure and capability-specific browser/computer assemblies. Add native-workspace support to the file role using the existing backend owners where that role supports it. Verify stable identity and storage across instance replacement.

Acceptance starts an independent node, performs real work through a different Host, stops the instance, restarts it with its original state and files, and continues with the same logical resource. Repeat browser profile reopening and artifact access through the browser role. Test native branch mount/release and file recovery on supported OS backends. Measure the installed graph and first real operation for each role.

### 4. Host activity and supervisor-assisted parking

Expose aggregated demand and next-wake facts, then implement the admission/wake handoff and graceful parking path. Integrate a controlled local supervisor before any cloud-specific adapter.

Acceptance parks a Host with a timed continuation, wakes it and admits the occurrence once. Deliver a new message across the parking boundary, exercise duplicate/stale wake notifications, and restart after wake publication but before process exit. Pending original effects reconcile through their original owners. A Host requiring an untransferred event listener remains present with that explicit reason. User-requested Bot sleep continues to block that Bot's automatic execution.

### Measurements and regression coverage

Use the existing [performance methodology](../performance.md), startup events and native/transport integration fixtures. Record idle Host baseline, message acceptance to model dispatch, actual resource acquisition to first useful result, spawned process count, private memory and memory returned after release. Separate local/remote resources and cold/warm paths. Report model-provider latency independently.

Compare a single active Bot and several Bots sharing resources, then revisit after idle release. Test disk pressure and failed preparation where a real operation writes or publishes state. Resource-list rendering should produce zero execution-environment starts, while explicit probing and required context reads are counted separately. Set warm-retention policy from the measured cold-start cost and retained footprint.

Extend focused existing tests for changed behavior and add a small number of race/continuity regressions. End-to-end checks should enter through public HTTP/client APIs and invoke the actual kernel/resource owners. Useful starting fixtures include [context HTTP](../../packages/web/application-host/lib/kernel/context-http-review.native.test.ts), [file resources](../../packages/web/application-host/lib/kernel/file-resource-audit.native.test.ts), [source inheritance](../../packages/web/application-host/lib/kernel/source-inheritance-review.native.test.ts), [resource nodes](../../packages/web/application-host/lib/kernel/resource-node.native.test.ts), [browser resources](../../packages/web/application-host/lib/browser/browser-resources.test.ts) and [Computer execution](../../packages/web/application-host/lib/kernel/computer-review.native.test.ts).

Ship each coherent behavior through its normal entry points. Fold completed sections into the domain guides and retire replaced preparation/release paths in the same implementation change. The existing runtime owns the resulting state throughout the migration.
