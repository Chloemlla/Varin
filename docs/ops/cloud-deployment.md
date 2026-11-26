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

### Resource Node (`docker-compose.resource-node.yml`)

Expose a dev/test machine's files and commands to an existing Agent Host without running a full app:

1. Point `VARIN_NODE_WORKSPACE` at the directory to share (mapped to `/home/varin/workspaces`; accessible by UID `1000:1000`). Node state lives in its own `varin_node_state` volume (never share state dirs with a full app).
2. Generate an offline pairing token (read-only by default; add `--allow-write` / `--allow-commands` only when intended — commands run as the node user, not a sandbox):
   ```bash
   docker compose -f docker-compose.resource-node.yml run --rm --no-deps \
     -v /abs/private-dir:/private varin-node pair --output /private/agent-pair.json
   ```
3. Start the node (`docker compose -f docker-compose.resource-node.yml up -d`, bound to `127.0.0.1:3001` by default; reach cross-machine via SSH forward or controlled HTTPS) and register its address + token in your Agent Host's Connections settings. Revoke with `revoke <clientId>` while stopped.

The node image stages only the JavaScript and assets reachable by its compiled Resource Node entrypoint, a role-specific frozen Bun lock, and the workspace packages reachable by that role. Its build follows the frozen installed dependency graph and rejects unrelated installed packages. Use `bun run update:resource-node-lock` for dependency/version metadata changes; for a changed import graph, build the Cloud Runtime first, then run `node scripts/build-resource-node.mjs artifacts/cloud-runtime artifacts/resource-node --update-lock` before rebuilding the image. The node health check probes its live resource kernel control channel without starting a kernel or acquiring a workspace.


### Runtime Environment

| Variable | Behavior |
| --- | --- |
| `VARIN_UI_PASSWORD` | Required when reachable beyond loopback |
| `VARIN_HOST` | Bind address (Compose default: `0.0.0.0`) |
| `VARIN_DATA_DIR` | Persistent Varin data root |
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

These two new image targets are built and qualified in the disposable container
validation graph. This does not publish new tags or change ordinary release image
names. Use an exact source revision and immutable configured runtime base when
building a deployment artifact.
