Your conversation can stay on your laptop while a worker runs tools on another machine. Register an SSH node, install the exact PanCode build if needed, verify its project and model route, then choose where the first bounded task runs.

::: note Version scope
Remote workers use your existing SSH access. They do not grant access to institutional systems or replace their scheduler and data rules.
:::

::: needs
- Noninteractive SSH access to a machine you may use for work.
- PanCode on the node at exactly your client's version. For an automatic install, the node needs Node.js 22.19 or newer and npm on its noninteractive SSH PATH.
- The project at the same absolute path on the client and node, using shared storage or matching clean Git checkouts.
- A model route the worker can reach from the node.
:::

## Choose where each part runs

::: diagram remote-placement
:::

Worker placement and inference are separate. A local worker calling a remote model endpoint runs tools locally. An SSH worker runs tools on the selected node. A target URL containing `localhost` refers to the worker's machine.

Choose a node for the compiler, filesystem, data or capacity the task needs. Declared labels such as `gpu` help describe it, but they do not prove observed hardware or available memory. A remote worker using a cloud target can send model input to that provider under the existing information policy.

## Add one SSH node

From your project root, register an SSH alias, hostname or address:

```sh
pancode fleet nodes add build-node --host build-node --max-workers 1
pancode fleet nodes list
```

The implicit `local` node already exists. Adding a node keeps unpinned work local. The new node starts as **not checked**.

Use an existing SSH alias to select the user, port and identity. You can also pass `--user`, `--port` and `--identity-file` explicitly. `--labels cpu,build` adds operator declarations. Start with one slot until you know the node's workload and resource limits.

In the terminal, `/settings workers` opens the **Workers** area; choose **Add SSH node** under **Machines**. The guided flow asks for a name and host, then offers to test and record readiness or preview an install. Open a node row to see evidence and timestamps, test it, preview an install or remove its saved entry. A test started here always records its result.

::: capture tui-settings-fleet
:::

### Use a LAN endpoint or optional Tailscale discovery

If the client and node share a network, prefer a LAN endpoint you have verified with SSH. Otherwise, a reachable Tailscale address or MagicDNS name can use the same worker transport.

```sh
pancode fleet nodes discover
pancode fleet nodes add travel-node --host travel-node.example-tailnet.ts.net
```

Discovery is opt-in. It reads `tailscale status --json` when the CLI is installed and signed in, lists MagicDNS names and IP addresses, and leaves the selection to you. The TUI's **Discover with Tailscale** lets you pick an endpoint and name the node. A discovered peer has no proven SSH access, runtime or project readiness. You can add an SSH host directly without Tailscale.

The endpoint can matter substantially. In one measurement on this project's development network, a 4 MiB SSH transfer ran at about **173 MiB/s over LAN and 1.4 MiB/s over Tailscale**. SSH setup and existing connection multiplexing affect those numbers; measure your own route. PanCode uses the host you configure and does not automatically switch between addresses.

## Install the exact client build

If the node lacks a matching PanCode runtime, preview a user-level install:

```sh
pancode fleet nodes install build-node
```

Review the package size, digest and destination. Then execute it:

```sh
pancode fleet nodes install build-node --yes
```

PanCode packs the build the client actually runs, transfers it over SSH, checks its SHA-256 digest, and installs it under the node's `~/.local/share/pancode/workers/<digest>/`. The install uses the node's existing Node.js and npm, verifies the version and updates the saved worker entry. The installer does not require sudo or modify services or shell profiles. Optional SDK dependencies are omitted.

You can also manage PanCode yourself, for example with the standard installer on a cluster login node, whose private Node.js is not on `PATH`. The default invocation is `pancode worker`. A custom `--entry` that ends in ` worker` is checked through its base command's `--version`; any other entry needs an explicit `--version-command`. The version check is never skipped.

## Prepare and verify the project

Choose one supported arrangement:

| Arrangement | What PanCode verifies | Available work |
| --- | --- | --- |
| Shared storage at the same absolute path | A transient client-side file challenge is visible from the node. | Read-only and mutating workers use that storage. |
| Independent checkout at the same absolute path | Both trees are clean, have the same Git HEAD and matching root history. | Read-only work; mutations through an isolated task worktree and SSH commit return. |

PanCode does not clone an arbitrary repository, map different paths, install project dependencies or stage datasets. Prepare those yourself. For independent checkouts, update both to the same clean baseline before testing.

::: steps
### Observe first

```sh
pancode fleet nodes test build-node
pancode doctor
```

These commands observe the node without creating directories there or granting new dispatch eligibility. A plain test can identify a clean matching checkout; recording also permits the transient client-side challenge that proves shared storage.

Model facts distinguish network reachability, access to the model listing, model presence and runtime support. Unknown remains unknown; a catalog listing is not a successful generation or proof of a resident model.

Each registered node adds a `fleet node <id>` row to `doctor` with its host, remote version and project check. The recording shows the report on a fresh install, before any node or model is added; each warning names the command that clears it.

::: capture cli-doctor
:::

### Record readiness for this project

```sh
pancode fleet nodes test build-node --record
pancode fleet nodes list
```

A passing recorded check makes the node **ready for this project**. A failed recorded check revokes previous eligibility. Records expire after one day and bind the entire connection configuration and client version. Changing the host, user, port, key or worker entry requires another recorded check.

`doctor --fix` can record all node checks, along with its broader local repairs. Run plain `doctor` first to review those repairs. The node-specific test is the focused route when you only want to record one node.

### Refresh after an upgrade or endpoint change

Install the new exact client build when needed, then repeat the recorded test from the project root. A pinned task with an invalid or expired check fails with a reason; it does not silently run elsewhere.
:::

## Choose the first worker

Keep the first task read-only and familiar. For example, ask PanCode:

```text
Use a read-only Scout to inspect the README and explain this project's test command.
Before dispatching, ask me once where to run it, offering local and suitable verified fleet nodes.
```

Scout is PanCode's built-in read-only agent for finding your way around a codebase. When a verified node suits substantial work and no preference or pin exists, PanCode asks once for the session. The choice remembers the exact node id for later unpinned work. The question does not replace the existing dispatch-plan approval. If you explicitly request `build-node`, it can be pinned directly.

A **Standing worker node preference**, under **Machines** in the Workers area of `/settings`, persists across sessions. Placement priority is an explicit task node, a profile pin, the session choice, the standing preference, then local. Headless runs never ask; configure a preference or explicit pin before running them.

Remote workers run under their own permits. The safety judge does not answer for a remote placement, so at `default` a remote worker's ordinary ask is denied. Worker slots limit concurrency; they do not create a scheduler allocation. On a university or laboratory cluster, use an approved execution environment.

## Return edits from an independent checkout

An editing dispatch to an independent node checkout must use `worktree: true`. Ask PanCode to use an isolated task worktree, name the files the worker may change and declare the host checks you want before application.

A matching branch and worktree are created on the node at the approved baseline. After the worker exits, PanCode commits the worker's edits there, fetches the branch through the existing SSH connection and checks the returned baseline and permitted paths.

The commit is imported into the owned local task worktree before the existing host verification and guarded apply flow. `apply: "preserve"` keeps the result on the local task branch, and `pancode fleet land` lists and lands such branches later.

Transfer, verification and application failures preserve the node branch for recovery. The run record names the node, branch, worktree and returned commit when available. Inspect preserved work before merging or deleting it. A successful guarded merge permits remote cleanup. The node's original checkout stays at its old baseline, so update it deliberately before the next dispatch that needs the new commit.

## Follow the result

Open **Workers** with Alt+W to see queued, active, failed and completed work with its actual node. In a session with panes, the same key opens a [live dashboard](/tutorials/panes-and-docks.html) beside the conversation. Review the worker result, receipt and project changes. The CLI's `pancode fleet status` and `pancode fleet view <runId>` expose durable results from another terminal.

SSH nodes and delegated peers are separate execution paths. A delegated peer is not an SSH machine whose resources or project access PanCode has verified.

## On a cluster

```sh
curl -fsSL https://pancode.dev/install.sh | sh
```

The installer needs no root, refuses to run under sudo, and downloads one bundle that carries its own Node.js. On x64 login nodes with glibc from 2.17 to 2.27 it selects the bundle built for them. Behind a proxy, export `https_proxy` first; the cluster guide lists the variables for mirrored and offline installs.

That Node.js is not added to `PATH`. A node installed this way already has PanCode, so skip `fleet nodes install` there and keep its version equal to your client's.

PanCode does not submit jobs for its own workers. The agent submits scheduler work through the scheduler clients in `bash`, under review; the [cluster guide](/docs/guide/hpc-clusters.html) covers it.

::: limits
- SSH access, exact PanCode version and the same absolute project path remain prerequisites.
- Project dependencies and datasets need your own staging; there is no arbitrary repository sync or path mapping.
- Independent-checkout edits require isolated task worktrees and the existing verification and application gates.
- Institutional access rules and schedulers still govern where work may run.
- Worker slots limit concurrency. They are not an allocation, and a login node is not a compute node.
- A remote worker sandboxes its commands only when bubblewrap is present on that node.
- A worker that uses a cloud model sends its input to that provider from the node.
- A worker on a node opens that node's own project store. Admission refuses store tag grants to a remote node, so run store-writing tasks locally.
:::

::: next
- [Your first session with PanCode](/tutorials/first-session.html)
- [Fleet guide](/docs/guide/fleet-dispatch.html)
- [Install on a cluster](/docs/guide/hpc-clusters.html)
- [Install PanCode](/#start)
:::
