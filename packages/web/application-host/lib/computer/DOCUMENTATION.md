# Computer Use admission and feedback

`ComputerService` owns desktop discovery, native OS drivers, the single ordered input lane per physical desktop, human control/takeover, remote peer routing, and viewer streams. [`computer-automation.ts`](computer-automation.ts) layers ephemeral work assignments over that lane without creating a second scheduler or desktop backend.

## Entrypoints and routes

| File(s) | Responsibility |
| --- | --- |
| [`computer-service.ts`](computer-service.ts), [`computer-automation.ts`](computer-automation.ts) | Desktop catalog, single-controller input lane, assignment/control lifecycle, outbox, and viewer streams |
| [`computer-actor.ts`](computer-actor.ts), [`computer-request.ts`](computer-request.ts), [`computer-records.ts`](computer-records.ts) | Work/execution refs, child request/decision orchestration, and `runtimeVersion: 5` desktop record codec |
| [`action-receipt.ts`](action-receipt.ts), [`computer-evidence.ts`](computer-evidence.ts), [`computer-error.ts`](computer-error.ts), [`semantic-wait.ts`](semantic-wait.ts) | Typed action receipts, evidence journal, error classification, and `computer_await` sampling |
| [`desktop-drivers.ts`](desktop-drivers.ts), [`driver-host.ts`](driver-host.ts), [`desktop-media.ts`](desktop-media.ts), [`desktop-artifact-files.ts`](desktop-artifact-files.ts) | Native helper pool, media decoding/frame streams, and registered desktop artifact downloads |
| [`linux-desktop.ts`](linux-desktop.ts), [`vm-provider.ts`](vm-provider.ts), [`libvirt-provider.ts`](libvirt-provider.ts), [`vm-guest-*.ts`](vm-guest-connection.ts) | Managed Linux sessions and VM guest lifecycle/provisioning |
| [`computer-routes.ts`](computer-routes.ts) | Authenticated `/api/computers/*` routes (viewer streams, desktop stop, remote peer dispatch, artifact download) |

Thread-scoped UI routes (`/api/threads/computer/state`, `/decide`, `/stop`) are served through [`../kernel/thread-routes.ts`](../kernel/thread-routes.ts) and [`../kernel/computer-runtime.ts`](../kernel/computer-runtime.ts). Platform driver build/signing details live in [`packages/computer-driver/README.md`](../../../../computer-driver/README.md).

## Thread identity, tool surface and assignments

- **Identity**: `ComputerWorkRef` identifies a native Thread/branch; `ComputerExecutionRef` adds its active Run. Rust `runtime.computer.scope` derives lineage from Catalog (callers cannot supply parent, Run, or role). Tool calls also validate their real ModelStep or PolicyAction Operation.
- **Extension contract**: Native tools are exposed by the shipped `varin.builtin.computer` extension (`computer_list/apps/observe/query/await/act/cancel/release/request/access/grant/deny/wait`, `computer_control/open/put/install`, `computer_browser_read/browser`, `computer_office_read/office`, `computer_evidence`, `computer_environment`, `computer_prepare`, `computer_desktop_lifecycle`, `computer_artifact`). Default desktop selection freezes per execution; global/trusted-project Computer settings can disable dispatch.
- **Exclusivity**: One controller per physical desktop (main agent or granted child); multiple observers coexist. Separate windows on one desktop share control; separate desktops/VMs run in parallel. Observation IDs belong to `(Thread/branch, Run)`; control epochs include execution identity.
- **Child requests & grants**:
  - Children (including source-less pure-capability children and persistent scripts via `tools.invoke`) call `computer_request` (recorded in Catalog with ContentStore bodies); acceptance atomically queues a typed Environment input for the root.
  - Root tool decisions and user decisions share one request owner with stable command-key conflict checking. Grant reserves the physical assignment before publishing `granted`; lost publications reconcile the same claim without silent reissuance.
  - `computer_wait` is a distinct Job observation; cancelling it leaves the request/assignment intact. Child assignments belong to the child's Run and survive natural root completion.
- **Remote peers**: Remote assignments reserve at the owning Host first and require an opaque assignment token rechecked at dispatch. Revoked tokens cannot arrive late and become live; restarts do not renew tokens, and a crashed source's reservation requires explicit human takeover on the target (no speculative expiry timer).

## Semantic reads, actions and application automation

- **Observe & query**: `computer_observe` returns a paged outline (100 lines default, `textLimit: "max"` to expand) or `within` region; `observationId` + `offset` (or `includeWindows: true`) reads the retained Host tree without re-capturing. `computer_query` matches role/name/value/state without treating unknown attributes as `false`. Element refs bind `(observationId, index)` and must still be confirmed by the owning driver.
- **Act & await**: `computer_act` prefers native semantic primary actions on supported elements and only falls back when input is known not to have been dispatched. `computer_await` holds the lane only for short samples (incomplete reads never prove absence; window loss is not disappearance).
- **Browser, Office, files & lifecycle**:
  - Read tools (`computer_browser_read`, `computer_office_read`) and effect tools (`computer_browser`, `computer_office`) have separate schemas; child labels, scripts, and read assignments cannot escalate permissions.
  - `computer_control` awaits control reservation before returning state; upgrading a root's observation to control invalidates the old read epoch and requires a fresh scene read by the current controller to clear any handback fence.
  - `computer_put` returns stored managed-home revisions; `computer_install` preserves per-package results; `computer_prepare` and `computer_desktop_lifecycle` acquire control, invalidate old observations/queued input, and wait for actual helper exit (remote stop returns exact reset assignment IDs for the calling peer).
  - Browser screenshot data URLs decode into typed media parts. The evidence journal records work/Run provenance without typed text, expressions, credentialed URLs, or file bytes.
  - `computer_environment` reports frozen Run placement only; service forwarding belongs to [`environment_forward`](../harness/DOCUMENTATION.md#service-forward-ownership).
  - `computer_artifact` registers `computer.artifact` records under local Thread/Bot scope (peer ops never register foreign Threads locally); downloads verify byte length and SHA-256 against the registered revision.

## Cancellation, human takeover and physical-control barrier

- **Stop & terminal cleanup**: Root Stop captures the current Computer family; child Stop targets that child. Full viewer Stop (`/api/computers/desktops/:id/stop`) validates `automationEpoch` on the owning Host. Stop fences admission tickets, denies pending requests, cancels exact-Run Computer REPL evals, drains native/external work, and releases held input. Native terminal Run notifications trigger reconciliation only after Catalog confirms `completed`/`failed`/`cancelled`.
- **Human takeover & handback**: Takeover is always explicit (physical mouse motion never transfers control). It suspends the assignment, interrupts active automation, invalidates queued input, and releases held keys/buttons. Handback invalidates old observations and queues a durable continuation (entering an active Run at a legal boundary or launching a successor Run after natural completion); explicit Run/tree Stop and ended Goals cannot be revived. Interrupted-control records survive natural completion as provenance only.
- **Desktop outbox**: Retains immutable cancellation/handback facts until definite Catalog ACK; Stop persists short cancellation commands for pending handback IDs so lost responses retry safely without duplicating inputs or killing later handbacks.
- **Physical-control barrier (`runtimeVersion: 5`)**: `computer-records.ts` / `computer-service.ts` persist a `physicalControl` marker (Host control generation, helper identity, holder) before sending input. Malformed/obsolete records remain fenced (never auto-migrated or erased). Clearing the barrier requires the original helper's release ACK + callback/process drain (or managed desktop stop); a crashed local-console helper leaves release unconfirmed.
- **Receipts**: `ComputerActionReceipt` separates `effect` (`none`, `dispatched`, `partial`, `verified`, `unknown`) from `inputWriterStopped`. OS acceptance is not application completion; only value readback confirms `set_value`. Lost responses remain `unknown` even if later cancellation confirms writer drain.

## Catalog discovery and on-demand acquisition

Catalog reads and changing the default target do not start native helpers or
probe capabilities. The catalog keeps the owning Host's last observation and
probe time; before a probe it reports the absence of capability evidence. The
explicit catalog refresh discovers remote machines and refreshes managed status
without capturing a frame. The individual Probe command acquires the selected
driver and reports its observed capabilities. A new active operation may
discover its explicitly selected remote Host if no local mirror exists yet.

## Dedicated Computer node

The built Application Host includes a standalone `computer-node.js` entry.
Set an absolute private `VARIN_DATA_DIR`; the optional
`VARIN_COMPUTER_DRIVER_DIR` points to the same platform driver assets as the
full Host. This role starts the resource kernel and the existing Computer
owner only. It does not expose Agent, UI, file/command node, VM provisioning
or general Host configuration endpoints. Default listen address is loopback.
Use a trusted encrypted tunnel or reverse proxy for cross-device deployment.

Create a coordinator credential while the node is stopped:
`node computer-node.js pair --output /private/computer-client.json`.
It grants desktop observation, not input. Add `--allow-control` to allow
control of the selected desktop and `--allow-system` (which also requires
control) for managed lifecycle, recipe installation, artifacts writes and
explicit app binary, path or command selection. Store the token in the
coordinator's existing desktop Host connection. `revoke CLIENT_ID` is also
offline. The node accepts bearer credentials only; it does not issue UI
sessions. Assignment leases are bound to both the authenticated peer and the
owning process. Reconnect after restart must reacquire leases; durable
device identity and the last observed capabilities remain in the private
state directory. Live views use the original owner frame or read-only RFB
media lane without a second input authority.

Use platform-specific drivers and operating-system authorization as before.
A Linux service with no permitted graphical session has control-plane health
but no verified capture/input capability until its driver and session are
available. Windows and macOS helpers live on their respective native hosts,
not inside the Linux resource image.

For a real X11 role acceptance on a Linux developer/CI worker, build the
release kernel first (or set `VARIN_TEST_KERNEL_PATH` to that binary), install
the usual workspace dependencies, then run
`./scripts/test-computer-role-x11.sh`. On Debian-family distributions the
additional test dependencies are `xvfb xauth x11-xserver-utils dbus python3-gi
gir1.2-atspi-2.0 gir1.2-gtk-3.0`. Use a `python3` on PATH that sees those
system typelibs. The script fails immediately if requirements are missing.
It creates a private Xauthority-protected Xvfb display and D-Bus session,
paints a synthetic root window, and verifies actual PNG fixture pixels through
a separate coordinator's binary stream, before and after role restart.
The role and original desktop IDs must survive; the previous control lease
must fail before dispatch, and a new lease must reach action validation.
The invalid action used for that check does not emit keyboard or pointer input.
This does not certify capture on Wayland, Windows or macOS, or the packaged
Docker image.

## Native drivers, capture sessions and visual feedback

- **Windows**: Launches version/build-verified `VarinComputer.exe` directly; a same-user local named pipe fences/releases input independently of the MTA UIA worker. Interrupt retires the input helper permanently (awaited until process exit) while capture runs in a separate read-only process. The final frame subscriber drains in-flight capture before retiring that helper; a new subscriber waits for retirement if it has already started. This does not stop the input helper.
- **macOS & Wayland**: Drivers advertise `sharedDesktopSession` to `desktop-drivers.ts`: controller observations/input keep one ordered lane while viewer `capture_frame` uses a separate correlated read-only lane on the same process. Closing a viewer preserves platform authorization; desktop reset or Host disposal closes the helper after owner cleanup.
- **Gestures & viewer streams**: Helpers emit coordinate/operation NDJSON gestures (never typed text). Updated peers negotiate a binary stream on the desktop event route (older peers keep SSE) with unchanged-frame suppression, single-newest-frame backpressure, and paused capture for hidden views.
- **Overlays & UI**: On Windows, Electron renders click-through, nonfocusable overlays excluded from capture via `setContentProtection` (applied only to overlays, never product windows) plus a bottom control bar (Take control / Return to Varin / Cancel). Linux/macOS show feedback in the viewer. `useComputerAutomation` projects Host snapshots + stream invalidations without polling or probing desktops.
