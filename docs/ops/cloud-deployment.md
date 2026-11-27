# Cloud Deployment

Varin uses one canonical cloud runtime layout shared by Docker images, local smoke checks, and SSH deployments: compiled Web Host/UI/CLI, `application-client`, `protocol`, `script-runtime`, `settings-store`, required extension packages, and the verified platform `varin-kernel` binary + manifest. Exact closure: `CLOUD_RUNTIME_PACKAGE_DIRS` in [scripts/build-cloud-runtime.mjs](../../scripts/build-cloud-runtime.mjs).

## Container Images

Published to **`ghcr.io/astrmira`** (from v0.9.50+). Update `VARIN_IMAGE` / `VARIN_RUNTIME_BASE_IMAGE` if overriding from older namespaces.

| Image | Contents & Aliases |
| --- | --- |
| `ghcr.io/astrmira/varin` | Default slim app (`varin-slim` points to the same digest) |
| `ghcr.io/astrmira/varin-toolbelt` | App with preinstalled dev toolchains (Java/Maven, Go/gopls, Rust/rust-analyzer, LSPs, `gh`, `ripgrep`, rootless BuildKit, amd64 Chrome/Playwright) |
| `ghcr.io/astrmira/varin-node` | Standalone Resource Node (files/commands only; no UI, models, Bot, or Catalog) |
| `ghcr.io/astrmira/varin-runtime-slim` | Slim base (Bun, Node, Git, SSH, `cloudflared`, Python + native build tools) |
| `ghcr.io/astrmira/varin-runtime-toolbelt` | Toolbelt base (`varin-runtime-base` points to the same digest) |

Images include `/etc/varin/image-capabilities.json`, `io.varin.image.role`, `io.varin.image.variant`, provenance, and SBOMs.

### Release & Commit Workflows

- **Official releases (`docker.yml`)**: Triggered by matching `v<version>` tag push or manual `release_ref` from `main`. Builds `linux/amd64` + `linux/arm64`, pins apps to exact base digests, runs Linux qualification + real amd64 smoke (checking `/health`, `releaseId`, native kernel, brokered services, and graceful `SIGTERM` exit code `143` within 15s), verifies anonymous GHCR pull, then promotes immutable version/`sha-<SHA>` tags and (for highest stable tag only) floating `latest`/`0.9`/`0`.
  - Resume failed promotion without rebuilding: `gh workflow run docker.yml --ref main -f release_ref=vX.Y.Z -f resume_run_id=<ID> -f resume_run_attempt=<N>`
  - Move tag and re-publish same version explicitly: pass `-f replace_version=true`.
- **Commit images (`docker-commit.yml`)**: Manual dispatch from `main` only (`-f source_sha=<40-char SHA>` optional). Runs full CI + dual smoke and publishes immutable `commit-<SHA>` tags only (never touches `latest` or release tags). Resume with `-f resume_run_id=<ID>`.
- **Read-only PR check (`container-check.yml`)**: Runs against a local runner registry with no GHCR push privileges; tests promotion protocol with scratch multi-arch fixtures.

## Docker Compose

Prepare UID/GID `1000:1000` bind mounts before starting:

```bash
mkdir -p data/varin data/ssh data/cloudflared workspaces
sudo chown -R 1000:1000 data workspaces
export VARIN_UI_PASSWORD="$(openssl rand -base64 24)"
docker compose up -d
```

For the toolbelt variant:

```bash
docker compose -f docker-compose.yml -f docker-compose.toolbelt.yml up -d
```

| Host path | Container path | Purpose |
| --- | --- | --- |
| `data/varin` | `/home/varin/.config/varin` | Settings, auth keys, pairing, tunnels, extensions, Rust Catalog/Storage/recovery roots |
| `data/ssh` | `/home/varin/.ssh` | SSH keys for Git |
| `data/cloudflared` | `/home/varin/.cloudflared` | Managed-local Cloudflare config/credentials |
| `workspaces` | `/home/varin/workspaces` | User projects |

Verify readiness (checks `status: "ok"`, expected `varinVersion` / `releaseId`, and `kernel.ready: true`):

```bash
curl --fail http://127.0.0.1:3000/health
```

### Operator policy and gateway credentials

Set `VARIN_DEPLOYMENT_POLICY` to an absolute path on an operator-owned mount outside
`VARIN_DATA_DIR`. The Host reads the policy at startup. Unknown policy fields prevent startup.
Without a policy, the Host uses its personal-installation defaults.

```json
{
  "version": 1,
  "ingress": { "mode": "gateway" },
  "modelCredentials": { "sources": ["api-key", "oauth"], "oauthIssuers": ["openai-codex"] },
  "egress": { "userDestinations": "public" },
  "connections": { "staticHosts": false, "ssh": false },
  "mcp": { "transports": ["http", "stdio"], "stdioPlacement": "managed" },
  "background": { "updateChecks": false }
}
```

Issue a credential with the Application Host stopped. Use the same data root as the Host
and a private output directory. The output file holds the client ID and token.

```bash
varin clients issue --profile full-control --output /private/gateway.json
varin clients revoke CLIENT_ID
```

In the application image, use `node packages/web/bin/cli.js clients`. For offline
provisioning, mount the state volume and private output directory and use the Node
entrypoint directly. The policy file may be mounted separately when serving the Host.

```sh
docker run --rm --user 1000:1000 --entrypoint node \
  -v "$PWD/data/varin:/home/varin/.config/varin" \
  -v "$PWD/private:/private" \
  ghcr.io/astrmira/varin:YOUR_VERSION \
  packages/web/bin/cli.js clients issue --profile full-control --output /private/gateway.json
```

Connect the gateway on the private service network. It supplies the issued bearer for HTTP,
SSE and WebSocket upgrades and forwards the public origin using the reverse proxy headers
described in [Reverse Proxy](REVERSE_PROXY.md). Gateway mode disables password, passkey,
pairing, tunnel and relay entry points. `/live` and `/health` remain available for service probes.
Authenticated clients can read `/api/system/deployment-policy` for the active settings without
the operator addresses or file paths.

- `modelCredentials.sources` admits stored API keys (`api-key`), declared `oauth` issuers,
  `environment`, `google-adc`, `aws-chain`, `anthropic-federation`, and anonymous credentials (`none`)
  individually. The Host keeps existing channel settings and marks excluded credentials unavailable.
- `egress.userDestinations` can be `all` or `public`. With `public`, the Host HTTP egress owner,
  kernel model transport, Host health probes for remote connections and Host-configured CDP
  connections check the addresses they connect to. A user-supplied URL stays subject to that
  policy even when it uses an operator service's hostname. Provider-managed Nodes use the
  endpoints and credentials issued by the trusted resource provider. Set `requiredProxy` to
  delegate destination enforcement to an operator HTTP(S) proxy. Deployments can route model
  gateway traffic through that proxy under its own policy. Commands, external programs and
  browser networking need their execution environment's network policy.
- `connections.staticHosts` and `connections.ssh` control saved direct Hosts and SSH connections.
  Both default to disabled with restricted egress, gateway ingress, or managed-only execution.
  Restricted egress uses provider-managed Nodes because saved-Host and SSH tunnels carry
  arbitrary protocols. Saved connections remain on disk.
- `mcp.transports` controls MCP HTTP and stdio. `stdioPlacement: "managed"` requires a managed
  resource for stdio. `stdioPlacement: "any"` also allows local execution.
- `extensions.sources` restricts third-party package sources, `realms` controls
  `native`, `brokered`, and `surface` entrypoints, and `artifactIntegrities` admits
  specific Varin artifacts. Set any list to `[]` to disallow all entries it controls.
  The distribution's built-in packages stay available. `agentStaging: false` disables
  Agent staging before workspace capture. `brokeredTransport: "sandbox"` runs
  third-party Host extensions through the resource provider and admits only the
  brokered Host realm for those extensions. For a first-party-only Host, set `sources: []`.
- `externalAgents.profiles` admits external harness profile IDs. Existing settings and
  conversations stay in the catalog. `managedInstalls: false` disables new managed
  installations and update checks. `placement: "managed"` requires a managed resource
  with a selected work location, including for preparation and reconnection. Apply profile
  controls on the execution Host as well if that Host is reachable by other coordinators.
- For a coordinator with a resource provider, set `execution.mode` to `none` and set
  `execution.defaultWorkspace` to the node's `resourceId`, `hostId` and absolute `path`.
  New threads use that workspace when they start a tool that needs it. Local workspace
  execution, local process spawning and local MCP stdio are refused by the coordinator.
  Source-backed language queries run on the selected Resource Node. Bot homes and
  attachments still use the Host's own data storage.
- Set the individual `localInference` switches to `false` to disable local embeddings
  (`embedding`), local dictation and TTS (`speech`), inference model downloads
  (`componentDownloads`), Host tokenizer paths (`tokenizerFiles`), or llama.cpp decision
  requests (`llamaCpp`).
- `background.modelDirectorySnapshot` and `background.pluginCatalogSnapshot` optionally point to
  read-only JSON files outside `VARIN_DATA_DIR`. They use the existing model directory and plugin
  discovery cache formats. The Host uses the supplied snapshots for catalog reads and leaves
  the user's own caches available for personal mode.

### Application Host parking (POSIX)

Run the supervisor on the same machine and under the same OS account as the Application
Host. Give it the policy above with gateway ingress. Use the `hostId` from the existing
data directory's `extensions/identity.json`. The external gateway connects to the
stable loopback port rather than to the Host's temporary port.

```sh
varin supervisor /absolute/varin-data/supervisor-wake HOST_ID run \
  --park-after-ms 300000 --listen-port 3000
```

The idle period is operator-selected. The Host waits for active owners, publishes the earliest
scheduled wake and closes its stores before the supervisor treats it as parked. Foreground
traffic waits for the Host and is forwarded once readiness returns. `/live` probes the
supervisor and `/health` reports the Host's readiness. Pending event pages submitted to
the local supervisor journal also wake the Host. After Catalog confirms durable receipt,
the journal discards new event bodies and keeps their retry identities. Sandboxed event
receivers retain their original authenticated stream through parking. The supervisor
commits pages before returning the cursor and requests a wake for new pages or a stopped
receiver. A connection-specific credential lease is held in memory for up to 30 minutes
or until the access token expires, whichever comes first. The Host resumes receivers using
the reconciled Catalog cursor. Local receivers and active file watches retain the Host.

The offline gateway credential can submit and enqueue new conversation inputs and stage
uploads while the Host is parked. The supervisor returns an inbox receipt and replays
the inputs in order before opening foreground traffic. The client follows the receipt
to final admission, and rejected inputs can be reopened from the conversation. Upload
bytes are staged by content hash in the private supervisor directory and removed after
acknowledgement.

### Resource Node (`docker-compose.resource-node.yml`)

Expose a dev/test machine's files and commands to an existing Agent Host without running a full app:

1. Point `VARIN_NODE_WORKSPACE` at the directory to share (mapped to `/home/varin/workspaces`; accessible by UID `1000:1000`). Node state lives in its own `varin_node_state` volume (never share state dirs with a full app).
2. Generate an offline pairing token (read-only by default; add `--allow-write` / `--allow-commands` only when intended — commands run as the node user, not a sandbox):
   ```bash
   docker compose -f docker-compose.resource-node.yml run --rm --no-deps \
     -v /abs/private-dir:/private varin-node pair --output /private/agent-pair.json
   ```
3. Start the node (`docker compose -f docker-compose.resource-node.yml up -d`, bound to `127.0.0.1:3001` by default; reach cross-machine via SSH forward or controlled HTTPS) and register its address + token in your Agent Host's Connections settings. Revoke with `revoke <clientId>` while stopped.

Command-enabled credentials also support JavaScript script sessions and project MCP over stdio. Both execute on the node under the selected live workspace. The node reads project instructions from that workspace. To enable its `.mcp.json`, record the node's canonical workspace path in `project-trust.json` in the node state directory, for example `{"/home/varin/workspaces": true}`.

Project Git commands also run on the node when the project uses its live workspace. They use Git, configuration and credentials on that machine. Git writes require write-enabled pairing.

Agent language queries use the node's bundled language servers or its local Go, Rust
and C/C++ toolchains. They need command-enabled pairing and access to the whole project.

External Agent conversations can use a Resource Node's live workspace. Install and authenticate the CLI on the node. Its built-in profiles are discovered from the node's environment. For a custom executable or arguments, edit `external-agents.json` in the node's state directory while the node is stopped. It contains `agents` (the existing external Agent configurations) and `defaultAgent` (a configured ID or `null`). For example, `{"agents":[{"id":"codex","name":"Codex","harness":"codex","command":"codex","args":[],"enabled":true}],"defaultAgent":null}`.

With `execution.defaultWorkspace`, the Host owner can start an external conversation without a project. The node creates its private directory under `external-workspaces` in the configured workspace and keeps it for resume until the conversation is deleted. Use command- and write-enabled pairing for this flow. Each conversation's selected execution owner is saved in the coordinating Host.

When a Host has an `execution.defaultWorkspace`, it sends Office rendering and spreadsheet recalculation to that workspace's Resource Node using its command-enabled pairing. Install LibreOffice in the node image or on the node machine. The renderer looks for `soffice` or uses the node's `VARIN_LIBREOFFICE_COMMAND` if set. Regular Office structure reads, attachments and exported files still use their existing storage owners.

The node image stages only the JavaScript and assets reachable by its compiled Resource Node entrypoint, a role-specific frozen Bun lock, and the workspace packages reachable by that role. Its build follows the frozen installed dependency graph and rejects unrelated installed packages. Use `bun run update:resource-node-lock` for dependency/version metadata changes; for a changed import graph, build the Cloud Runtime first, then run `node scripts/build-resource-node.mjs artifacts/cloud-runtime artifacts/resource-node --update-lock` before rebuilding the image. The node health check probes its live resource kernel control channel without starting a kernel or acquiring a workspace.

### On-demand Resource Node provider

Run `varin resource-provider --config /private/provider.json` as a separate process on the
engine machine. The provider owns Docker or Podman access. The Application Host uses
only the authenticated control socket and leased HTTP endpoint. With the local provider,
run the Host in the same network namespace as its loopback data listener.

Prepare separate directories for the workspace and the Resource Node state. Use the
matching Resource Node image to pair offline once with both directories mounted at
`/home/varin/workspaces` and `/home/varin/.config/varin`. Keep the pairing output
outside both trees. The state directory's `extensions/identity.json` records the
durable `hostId`. The provider control credential is a separate private JSON file
containing a randomly generated `token`.

```json
{
  "version": 1,
  "id": "local-engine",
  "socketPath": "/private/provider.sock",
  "credentialFile": "/private/provider-token.json",
  "engine": "docker",
  "leaseDurationMs": 120000,
  "startupTimeoutMs": 60000,
  "idleRetentionMs": 300000,
  "resources": [
    {
      "id": "workspace",
      "hostId": "RESOURCE_NODE_HOST_ID",
      "label": "Managed workspace",
      "image": "ghcr.io/astrmira/varin-node:YOUR_VERSION",
      "workspace": "/srv/varin/workspaces/user-a",
      "state": "/srv/varin/node-state/user-a",
      "credentialFile": "/private/user-a-node-pair.json"
    }
  ]
}
```

This policy fragment registers that provider and makes its workspace the fallback
for new chats and Bots. The path is interpreted on the Resource Node.

```json
{
  "resourceProvider": {
    "id": "local-engine",
    "socketPath": "/private/provider.sock",
    "credentialFile": "/private/provider-token.json"
  },
  "execution": {
    "defaultWorkspace": {
      "resourceId": "workspace",
      "hostId": "RESOURCE_NODE_HOST_ID",
      "path": "/home/varin/workspaces"
    }
  }
}
```

Listing locations reads the control socket without starting a container. A file or
command request acquires the node. Bound Sources and response streams retain their
leases. Idle retirement requires the native node to report that its authorities,
writers and compute have drained. The engine stops the original container and
confirms its removal before the provider reports volume detach. The next generation
uses the same state and workspace, and the saved location keeps its identity.
Leave `idleRetentionMs` absent to keep the node running after use. On Windows,
use a private named pipe such as `\\\\.\\pipe\\varin-provider` for `socketPath`.

The local provider serves the Resource Node's live file, terminal and process
operations. The default workspace setting selects a location for new work.
Explicitly selected locations still use their configured owner. The provider drops Linux
capabilities and sets no-new-privileges on execution containers. Set their `network` to an
engine network with the outbound rules appropriate for the workspace.

For a Browser Node, set `role` to `browser`, use the Browser Node image and set
`browserId` to its provisioned connection ID. The entry takes a persistent
`state` directory and the credential issued by the Browser Node's offline
`pair` command. The node's CDP connection is provisioned in that state directory
before first use. Listing browsers reads provider inventory. Opening one starts
the Browser Node and connects to its CDP endpoint. Page holds keep the node alive,
and an old page binding stays tied to its original node generation. The CDP
browser process follows its own deployment lifecycle. Computer Node connections
use their existing device settings.

### Extension sandboxes

Build the `extension-node` Dockerfile target from the same revision as the Application Host.
Set `extensions.brokeredTransport` to `sandbox` in the Host policy. The default
`extensions.sandboxScope: "user"` shares one resource across the owner's third-party
extensions. For each user's provider, define one `extensions` resource without an `extensionId`.

```json
{
  "id": "extension-sandbox",
  "hostId": "extension-sandbox-host",
  "label": "Extension sandbox",
  "role": "extensions",
  "image": "varin-extension-node:local",
  "credentialFile": "/private/extension-sandbox.json"
}
```

Set `extensions.sandboxScope: "extension"` to use a dedicated container for each extension.
In that mode give each provider resource a distinct ID, Host ID, credential file, and
`extensionId`. The same options apply to self-hosted personal installations. Personal
installations with no sandbox policy keep their local brokered processes. Bundled
first-party extensions keep their usual transport in both modes.

Give each sandbox credential JSON a random `token`. The provider mounts it beneath a
root-only directory. Each extension has a separate unprivileged UID and group, private
scratch and verified artifact directory, and its own scoped broker credential.
The Node relay and provider hold the credentials. Workers have a private IPC channel.
Workers create files with owner-only permissions by default. Extensions in one shared
container use the same network namespace, including loopback and abstract sockets.
Use dedicated containers when extensions need separate network namespaces.
Set `network` to an engine network with the outbound rules the extensions need.
Extension storage and capability decisions stay on the Application Host. Package paths
point to the sandbox copy. Use Host capabilities for resources outside the sandbox.

### Runtime Environment

| Variable | Behavior |
| --- | --- |
| `VARIN_UI_PASSWORD` | Required when reachable beyond loopback |
| `VARIN_HOST` | Bind address (Compose default: `0.0.0.0`) |
| `VARIN_DATA_DIR` | Persistent Varin data root |
| `VARIN_CACHE_DIR` | Optional absolute root for rebuildable model and MCP metadata and tokenizer files. Each Host uses its own subdirectory. |
| `VARIN_WORKSPACE_ROOT` | Default directory for mounted projects |
| `VARIN_WORKSPACE_LOCKDOWN` | Defaults to `false` in application images. Live file tools follow the container user's filesystem permissions. Set `true` in the service environment to limit access to `VARIN_WORKSPACE_ROOT`. |
| `VARIN_SHUTDOWN_TIMEOUT_MS` | Host shutdown budget in ms (default `10000`) |
| `VARIN_STOP_GRACE_PERIOD` | Compose stop grace (default `15s`; must exceed shutdown timeout) |
| `VARIN_RESEARCH_RESERVE_CPU_CORES` / `_MEMORY_MB` | Explicit CPU/memory reserved from research admission (default `0`) |
| `VARIN_TUNNEL_PROVIDER` / `_MODE` / `_HOSTNAME` / `_TOKEN` / `_CONFIG` | Tunnel settings (`cloudflare`: `quick` / `managed-remote` / `managed-local`) |

`/health` returns `503` as soon as draining starts or the kernel is unavailable; `/live` checks HTTP process liveness only. Never pass passwords or tunnel tokens as Docker build args.

## Cold Backup & Isolated Recovery

See [cold-backup.md](cold-backup.md). Stop every writer first; never delete WAL files or boot a copied `hostId` on the live network.

## SSH Deployment

Builds the canonical cloud tree, uploads a SHA-256-verified archive, installs target-platform deps, validates the native kernel, and atomically switches `current -> releases/<id>` with automatic rollback to `previous` on `/health` failure.

- **Remote requirements**: Linux, Node.js >= 22.19, Bun in non-interactive SSH `PATH`, `tar`, POSIX symlinks, and a persistent data dir outside `releases/`.
- **Config**: `~/.config/varin/varin-dev.json` (template: [scripts/varin-dev.config.example.json](../../scripts/varin-dev.config.example.json)). Keep the remote `envFile` mode `0600` or `0400` owned by the deploy user.
- **Deploy**:
  ```bash
  bun run varin-dev remote-deploy-web --remote-id production
  ```

## Building the Canonical Runtime Directly

```bash
bun run build:cloud-runtime
# Local smoke without archive:
node scripts/build-cloud-runtime.mjs --install --no-archive
node artifacts/cloud-runtime/packages/web/bin/cli.js serve --foreground
```

When production dependencies or overrides change, refresh and review the dedicated lockfile:

```bash
bun run update:cloud-runtime-lock
```

### Dedicated Browser control plane

Build the separate Linux container with `docker build --target browser-node` using
the same pinned runtime base and source inputs as the other image targets. This image
runs only the authenticated managed Browser API and its local durable identity/auth
state. It does not include Chromium, the Application Host, or an Electron renderer.
Provision a supported Chromium CDP process (and its own persistent profile volume)
separately, on private networking. Do not publish the upstream CDP port.

- Set `VARIN_BROWSER_CDP_ENDPOINT` to the provisioned HTTP(S) or WebSocket address.
  An operator may instead provision `browser-node-settings.json` in the private node
  state directory, with the standard Browser connections under `browser`.
- Keep `VARIN_DATA_DIR` on its own persistent volume. For Browser file transfer, set
  `VARIN_BROWSER_CDP_SCRATCH_DIRECTORY` and mount its directory at the **same absolute
  path** in both services. Without a shared scratch volume the CDP provider deliberately
  does not advertise upload/download. Keep the Chromium profile on its separate volume.
- Run the image's offline `pair --output /private/client.json` command with the state
  volume mounted and the serving Browser container stopped. Keep the generated file on a
  private mount outside the state and scratch trees. Configure the node URL/token in
  the coordinator's existing trusted Host connections, then discover and acquire its
  Browser resource. `revoke CLIENT_ID` is also an offline command.
- `/health` reports ready control-plane state without dialing or starting a browser.
  The coordinator's authenticated Acquire opens the actual CDP connection. Its live
  instance identity derives from the Chrome debugger session, not the persistent node ID.
  Node and browser restarts can therefore preserve different parts of the binding.
- Configuration and probes on this role are local operator concerns: a paired Browser
  peer cannot ask the service to connect to arbitrary endpoints or read upstream headers.
  Protect the coordinator connection with the same private-network or HTTPS ingress
  requirements as a File and command node.

For an opt-in positive Browser integration check, use a local Chromium executable
and the matching release kernel on a machine that allows their native sockets
and process sandboxing. The test creates an isolated profile and loopback page;
it does not use a personal browser profile or an external website:

```sh
VARIN_TEST_BROWSER_CHROMIUM=/absolute/path/to/chromium \
VARIN_TEST_KERNEL_PATH=/absolute/path/to/varin-kernel \
  node node_modules/vitest/vitest.mjs run --config packages/web/vitest.kernel.config.ts browser-node-chromium.native.test.ts
```

This is separate from the default CI role smoke. It exercises the regular
coordinator and Browser node APIs, not a CDP stub: the Browser role may restart
without replacing its Chromium process or tab, and restarting Chromium keeps
the disk profile but invalidates the previously bound live instance.

The existing **Container validation** workflow also accepts the optional
`real_linux_roles` dispatch input. Enable it to run the real Chromium test and
the Computer driver's isolated Xvfb/AT-SPI test against the exact checked-out
source and the checksum-verified Linux/amd64 kernel from that run's Browser
candidate. Set `benchmark`, `toolbelt`, and `multi_platform` to false for a
focused run. Ordinary CI checks the shipped Linux Computer driver's PyGObject,
AT-SPI and GDK imports inside its exact image. It does not provision a desktop, and
the opt-in check exercises capture against the isolated runner display instead.

### Upgrade preflight

Stop the Host and disable automatic restart while inspecting its data volume.
Run `varin preflight --writers-stopped` from the **new** build with the existing
`VARIN_DATA_DIR`. The JSON report gives the Catalog and Storage format and any
knowledge database that needs conversion, including active semantic stores.
`upgrade` means the named format will be converted on start or first writable
use. Snapshot the stopped data volume before allowing that build to start.
`blocked` returns a nonzero exit status and gives the affected format or reason.
The command never opens a writer. A SQLite journal that still needs recovery
must be checkpointed by the current build or examined on a recovered copy.

Mount `VARIN_CACHE_DIR` separately when the deployment snapshots only durable
data. On first start, Varin moves existing model metadata and tokenizers into
the configured root. Existing MCP discovery data follows on first use of its
scope. Historical tokenizer references can still resolve by content digest.
Keep the cache mount when rolling between hosts if offline tokenizer availability
matters. An operator-supplied model-directory snapshot can be mounted read-only.

### Host lifecycle diagnostics

The owner-authenticated `GET /api/system/lifecycle` reports the next Catalog
wake as `catalog.nextWakeAtMs`, a UTC timestamp in milliseconds or `null` when
there is no scheduled wake. It comes from the same Catalog deadlines as the
native continuation worker, including timed waits, follow-ups, Bot inactivity
and Calendar. The `owners.provider` field counts allocations being prepared,
used or released. The endpoint is a read-only activity report.

### Dedicated Computer control plane

The Linux `computer-node` build target packages the existing platform driver alongside
its own frozen Node dependency graph, without the Host UI or Agent. Only this
dedicated image installs the Linux driver's AT-SPI and GDK runtime libraries. Keep its
`VARIN_DATA_DIR` mounted between launches. Its passive health confirms kernel control
and role ingress, not the presence of an accessible desktop, approved capture portal
or installed applications. A ready role can report that any specific capability is
unavailable. Install/expose the actual desktop session and supported platform
applications separately, using the regular Computer owner and OS approval model.
The Linux image is not a macOS or Windows service installer.

Run offline `pair --output /private/client.json` to grant observation only. The operator
can explicitly add `--allow-control`; `--allow-system` also requires control and permits
system-level Computer operations. Keep generated credentials on a private mount
separate from the durable role data. Use offline `revoke CLIENT_ID` to retire a grant.
Computer assignment credentials are additionally tied to their paired client and
to the serving process; reassume the actual desktop assignment after a restart.

To allocate that role on first use through the local container provider, register a
resource with `role: "computer"`, its node `hostId`, and the node's actual `desktopId`
in addition to the `id`, `label`, `image`, `state` and `credentialFile` fields above.
Use an operator-prepared image that starts the corresponding desktop session and
the Computer Node. The stock control-plane image leaves desktop provisioning to
the deployment. A provider-backed desktop is listed while its node is stopped.
An assignment, frame stream or VNC connection keeps the exact instance leased
until it closes. Retirement also checks the node for unresolved input authority
before stopping and detaching its state mount.

These two new image targets are built and qualified in the disposable container
validation graph. This does not publish new tags or change ordinary release image
names. Use an exact source revision and immutable configured runtime base when
building a deployment artifact.
