# HPC Clusters

This guide covers running PanCode on an HPC cluster: installing it without
root on a login node, connecting a model through a proxy or on a compute node,
letting the agent use the scheduler, and sharing one home directory across
nodes and users.

PanCode needs Node.js 22.19 or newer. Cluster login nodes often offer Node 18
or 20 through `module load nodejs`, run an old glibc (RHEL and CentOS 7 ship
2.17, while official Node 22 and 24 builds need 2.28), sit behind a proxy, or
have no internet at all. The installer handles each of these without root.

Source: installer selection and verification are in
[`scripts/install.sh`](../../scripts/install.sh); provider and proxy setup are in
`src/domains/providers/` and [`proxy-env.ts`](../../src/core/proxy-env.ts);
scheduler classification is in
[`policy-engine.ts`](../../src/domains/safety/policy-engine.ts) and
[`containment.ts`](../../src/domains/safety/containment.ts). Tests:
`tests/contracts/doctor-hpc.test.ts` and
`tests/contracts/doctor-slurm-controller.test.ts`.

## Quick start on a login node

1. **Install** without root: `curl -fsSL https://pancode.dev/install.sh | sh`,
   then `pancode doctor`. See [Install on a login node](#install-on-a-login-node).
2. **Connect a model**: a site setup file, a provider key, or a server you
   run on a compute node. Export your proxy first if the cluster has one. See
   [Connect a model](#connect-a-model).
3. **Use the scheduler** by asking in words, such as "submit job.sh and tell
   me when it starts". `sbatch`, `squeue` and the other clients are reviewed by
   the safety judge before they run, so name the action you want. See
   [Scheduler clients](#scheduler-clients).
4. **Let it write to scratch.** Shell commands may write only to the project
   and the temp folders without asking. Add your scratch space in user
   settings, with an absolute path:

   ```yaml
   safety:
     scratchRoots: [/scratch/alice]
   ```

5. **Keep results out of Git** with the store:
   `pancode store put results run-042.h5`. Every checkout of the project
   sees it. See [Store](panstore.md).

## Install on a login node

```bash
curl -fsSL https://pancode.dev/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
pancode doctor
```

The installer ends with the next step for this account, for example
`The first launch sets up a model. Found: ANTHROPIC_API_KEY.`, and, while
`~/.local/bin` is not on `PATH`, the launcher's full path to run until it is.
[Connect a model](#connect-a-model) below takes it from there to a first answer.

If pancode.dev is unreachable from the cluster, fetch the same script from the
latest GitHub release,
`https://github.com/akougkas/pancode/releases/latest/download/install.sh`, and
name the version with `--version`: the channel files that say which version
`latest` is live on pancode.dev, while the bundles and `SHA256SUMS` come from
GitHub.

The script (`scripts/install.sh`) is POSIX sh and needs `curl` or `wget`, `tar`,
`gzip` and a SHA-256 tool (`sha256sum`, `shasum` or `openssl`). It
never uses `module load`, the system `node`, or `sudo`, and it refuses to run
under `sudo` because that would install into root's home. It downloads one
bundle, an archive that holds PanCode, the Node.js it runs on and every
dependency, so it asks no package registry for anything. It picks the bundle
for the host:

| Host | Bundle |
| --- | --- |
| Linux x64 or arm64, glibc 2.28 or newer (a glibc host that also carries the musl loader, as Debian's `musl` package installs, still gets this bundle) | `linux-x64` or `linux-arm64` |
| Linux x64, glibc 2.17 to 2.27 (RHEL/CentOS 7 class) | `linux-x64-glibc-217` |
| Linux on musl (Alpine) | `linux-x64-musl` or `linux-arm64-musl`; they need `libstdc++` and `libgcc` (`apk add libstdc++`) |
| macOS arm64 or x64 | `darwin-arm64` or `darwin-x64` |
| Linux arm64 with glibc older than 2.28 | None exists; use conda-forge `nodejs` and `npm install -g @akougkas/pancode` with it |

`PANCODE_TARGET` forces a bundle when detection is wrong, for example
`PANCODE_TARGET=linux-x64-glibc-217` on a node whose `getconf` reports a
newer glibc than its compute nodes run.

Everything lands in your home directory: the installed versions under
`~/.local/share/pancode-install` (or `--install-dir`), and the launcher in
`~/.local/bin`. A bundle is about 85 MB to download and about 330 MB unpacked,
in roughly 20,000 files and directories, and the install root keeps the current and the previous
version. The installer skips the
Claude Agent SDK, about 224 MB, unless `--include-claude-sdk` is passed, and when it is
provisioned it lands under the data root (`~/.local/share/pancode`), not under
`--install-dir`. The installer refuses to start with under about 488 MB free at the
install root. On a small home quota, put the install root on a project filesystem with
`--install-dir /project/$USER/pancode` and keep the launcher in `~/.local/bin`. Compute nodes that mount the same home directory run
the same launcher. `--dry-run` prints the plan without downloading anything. The
full flag list is in [Installer options](installation-and-lifecycle.md).

Shell startup files are edited only when you pass `--modify-path`; otherwise
the installer prints the `export PATH=...` line to add yourself.

## How downloads are verified

The installer reads the release's `SHA256SUMS` and compares the bundle's SHA-256
with the line for it before unpacking anything. A mismatch stops the install and
leaves the active version as it was. Every release asset also carries a GitHub
build attestation, which a connected machine with the GitHub CLI can check:

```bash
gh attestation verify pancode-<version>-<target>.tar.gz --repo akougkas/pancode
```

The Node.js inside a bundle is pinned by SHA-256 in the repository, and the
Node.js release signature is verified when that pin is written, so the installer
needs no `gpg` on the cluster.

## Proxies

`curl` and `wget` read `https_proxy` and `http_proxy`. Export them before
running the installer:

```bash
export https_proxy=http://proxy.example.org:3128
export http_proxy="$https_proxy"
curl -fsSL https://pancode.dev/install.sh | sh
```

PanCode reads the same variables at run time. `HTTPS_PROXY`, `HTTP_PROXY`
and their lowercase forms apply to model requests, discovery probes, OAuth
refreshes and web fetches, and `pancode doctor` shows the proxy in effect.
`localhost`, `127.0.0.1` and `[::1]` always go direct. A `NO_PROXY` entry
matches a host by exact name or as a domain suffix (`example.com`,
`.example.com` and `*.example.com` all cover `api.example.com`), optionally
with `:port`, and `NO_PROXY=*` turns the proxy off. A CIDR range such as
`192.168.0.0/16` or an IPv4 wildcard such as `192.168.*` sends requests to IP
addresses inside it direct. Host names are not resolved to match a range, so a
model server you reach by host name goes through the proxy
unless `NO_PROXY` names that host:

```bash
export NO_PROXY=localhost,gpu-node-07,10.1.4.22
```

## Connect a model

PanCode sends prompts to a model it reaches over HTTP: a provider API, a
site or lab gateway, or a server such as vLLM or llama.cpp that you run on a
compute node. Its requests use the proxy variables in [Proxies](#proxies), so
export `https_proxy` and a `NO_PROXY` naming the cluster hosts it should reach
directly before connecting.

There are three ways to connect. Each saves a *target* in your user settings
and makes it the chat and worker model.

1. **A site setup file.** When your site or lab publishes one, import it. PanCode
   prints each address and where the key comes from, and asks once:

   ```bash
   pancode configure --import https://hpc.example.edu/pancode/setup.yaml
   export LAB_API_KEY=...    # the key variable the file names, if any
   ```

   The file can only name targets, routes, key variables and notes; it cannot
   hold a key or change safety settings. The format is in
   [Setup files](configuration-and-targets.md#setup-files).

2. **One command with flags**, for a gateway or server whose address and model
   you know. The key stays in your environment and is read at call time:

   ```bash
   pancode configure --id lab --runtime openai-compat \
     --url https://llm.lab.example.org/v1 --model qwen3-coder-480b \
     --api-key-env LAB_API_KEY --set-orchestrator --set-fleet-default
   ```

   `pancode configure --list` names the runtimes (`vllm`, `llamacpp`,
   `ollama`, `litellm`, `openai-compat`, `anthropic` and the rest). An
   unreachable address is saved with a warning, so this works before the
   server is up.

3. **The setup wizard.** Run `pancode` in a project with no model chosen,
   or `pancode configure`, and pick **A model server or gateway** and its
   address, or **An API key** and paste it.

**A server on a compute node.** Start the server inside a job, then forward
its port to the login node with SSH and connect to the forwarded port:

```bash
# in the job on gpu-node-07
vllm serve Qwen/Qwen3-Coder-30B-A3B-Instruct --port 8000

# on the login node
ssh -N -f -L 8000:localhost:8000 gpu-node-07
pancode configure --id gpu --runtime vllm --url http://127.0.0.1:8000 \
  --model Qwen/Qwen3-Coder-30B-A3B-Instruct --set-orchestrator --set-fleet-default
```

A login node is shared, so pick a port other users are unlikely to take, and
see [Shared login nodes](#shared-login-nodes) for why PanCode asks before using a
server it found on a local port. Connecting to `http://gpu-node-07:8000`
directly also works when the login node can reach it; name the host in
`NO_PROXY`.

**Sign in without a browser.** A login node has no display, so
`pancode auth login openai-codex` (or `anthropic-max`) prints a
link to open on your own computer and a code to enter there or paste back.
`--method device` picks the code flow on any machine.

**Ask the first question.**

```bash
cd /path/to/your/project
pancode run --read-only "Summarize this repository and how to run its tests."
pancode          # the interactive session
```

`pancode doctor` names anything still missing, such as a key variable not
set in this shell, with the command that fixes it. On a cluster, the agent's
scheduler commands are outward-action candidates and pass the containment and
approval checks described below; see
[Scheduler clients](#scheduler-clients).

## Scheduler clients

Slurm, PBS, LSF and Flux client commands (`squeue`, `sbatch`, `qstat`, `bsub`,
`flux` and the rest) are outward-action candidates, reviewed like `ssh`: at
the default autonomy level the safety judge decides first and asks you when it
has no verdict, contained yolo runs one only when your own message names it,
and unconfined yolo runs it. Whether a recognized literal line leaves the OS
sandbox is then decided by
[`containment.ts`](../../src/domains/safety/containment.ts); under
`safety.sandbox: required`, only the narrow listed literal forms leave, and
clients outside that list remain inside without the daemon credentials they
need. A script
that calls `sbatch` itself stays inside the sandbox and fails there, so submit
from the command line the agent runs rather than from a wrapper script. A
workspace script named like a client (`./sbatch`, `bin/ssh`) is not one and
stays inside the sandbox.
`/loop --command` and job poll commands get the environment `bash` gets, with
credentials scrubbed and `safety.sandboxPassEnv` honored, and a failing poll
shows its first stderr line. With the sandbox active, `pancode doctor` adds a
`scheduler commands` row when a scheduler client is on `PATH`.

## Shared login nodes

Other users run on the same login node, and often share the filesystem your
home is on.

- **Keep the state directory private.** Session transcripts, the session
  ledger and spilled tool output are written owner-only (`0700` directories,
  `0600` files). `pancode doctor` warns when the state or data root is
  open to group or other users, and `pancode doctor --fix` tightens it.
  Keep `PANCODE_HOME` or the state directory out of shared project space.
- **Do not accept a local server you do not run.** On a home with no chat
  model, PanCode may find a model server on a default local port. It uses one
  only after a yes, and on Linux the question names the account that owns the
  listener and defaults to no when it is another user. Prompts sent to
  someone else's server are readable by them; answer no and connect your own.
- **One home across nodes.** When the login node and compute nodes share one
  home, each host's workers are counted against that host's limits for the
  local node and for local-port servers, and a plan running on one node is
  not cut short by PanCode starting on another. Slots held by a host that died
  free up five minutes after they expire, or at once with
  `pancode session terminate <id> --force` once that session has stopped
  sending heartbeats.
- **Apptainer with its own pid namespace.** An instance started with `--pid`
  or `--containall` keeps the host's name but numbers its processes on its
  own. The lock PanCode takes on its state files (`settings.yaml`,
  `credentials.yaml`, the dispatch admission state) records the holder's pid
  namespace and boot, so a PanCode process on the host never takes a container
  holder's lock by mistaking it for a host process, and the reverse. A lock left by a container that has exited, or held where the kernel
  does not report namespace pids (before Linux 4.1, as on EL7), is taken
  over once it is 30 seconds old. Other records PanCode keeps on the home
  (session ownership, worker slot leases, the store lock, update and build
  locks) still compare plain pids,
  so do not share one home between the host and such a container: give the
  container its own `PANCODE_HOME`, or run it without `--pid` and
  `--containall` (the Apptainer default shares the host's pid namespace,
  which needs nothing).

## Airgapped and mirrored sites

On a cluster with no route out, install from a file. On a connected machine,
download the bundle for the cluster's target and `install.sh` from the release
page, `https://github.com/akougkas/pancode/releases`, copy both over, and run:

```bash
sh install.sh --bundle pancode-<version>-<target>.tar.gz
```

Nothing is fetched: the bundle holds Node.js, PanCode and its dependencies. An
install from a bundle file is pinned to that version, so `pancode upgrade` and
background updates leave it there, and the next version installs the same way.

A site that mirrors the releases points the installer at the mirror:

| Variable | Purpose |
| --- | --- |
| `PANCODE_RELEASE_MIRROR` | Base URL of the mirror, laid out as `<base>/channel/<latest\|beta>` (one line naming a version) and `<base>/v<version>/<release asset>` (`SHA256SUMS` and the bundles). `https://`, `http://` and `file://` all work for the installer, so a mirror on a shared filesystem needs no web server. |
| `PANCODE_BUNDLE` | One bundle by path, as `--bundle` |

The update check of an installed PanCode reads `<base>/channel/<channel>` from
the same variable when it names an `http` or `https` mirror.

The script fails closed on a checksum mismatch, so a mirror that
serves a modified bundle is refused rather than installed.

After install, a few optional assets download on first use: the Ruby and C#
code map grammars and the HDF5, NetCDF-4 and Parquet readers of the `data` tool.
Without network the code map falls back to line patterns for Ruby and C#, and
the `data` tool names the file to pre-seed; see
[First-use downloads and air-gapped hosts](installation-and-lifecycle.md#9-first-use-downloads-and-air-gapped-hosts).

## Choosing versions

| Option | Effect |
| --- | --- |
| `--version 0.9.0` or `PANCODE_VERSION` | Install that PanCode version, or `latest` or `beta` |
| `--channel beta` or `PANCODE_CHANNEL` | Follow a release channel (`latest` or `beta`) |
| `--rollback` | Point the launcher back at the previous installed version |

An exact version such as `--version 0.9.0` pins the install: `pancode upgrade`
and background updates leave it there, and `--version latest` (or `beta`)
releases the pin. A channel that resolves to a version older than the installed
one is refused before anything is installed. `pancode upgrade --channel latest`
still leaves a pre-release for the stable release, and a direct run of the
installer does so with `--leave-prerelease`; in any other case name that version with
`--version` or use `--rollback`. `--rollback` moves a pin to the version it restores. The
[installation guide](installation-and-lifecycle.md) has the details.

`pancode upgrade` installs the next version, with the Node.js it runs on, beside
the current one and switches the launcher.
`pancode uninstall` removes the launcher, every installed
version, and the config, data, state and cache roots; `--keep-config` and
`--keep-data` preserve those two roots.

## Using a Node you already have

If the site provides Node 22.19 or newer somewhere other than the default `PATH`,
for example a module whose `node` you cannot put first, point PanCode at it:

```bash
export PANCODE_NODE=/path/to/node22/bin/node
pancode --version
```

The package's `pancode` command checks the Node before loading anything else.
When `PANCODE_NODE` is set and names a different binary, it reruns itself
under that Node. Otherwise, on an older Node, it prints the installer command and
these options, naming the glibc limit when the host's glibc is older than 2.28.

## Checking the login node

`pancode doctor` reports a `toolchain <name>` row for the compilers, MPI
launchers, build systems, `python3` and `sbatch` it finds on `PATH`, so a login
node can be inspected before a workspace validation contract names any of them
([Doctor](doctor.md)).

## The HPC skill pack

The `hpc` pack in PanHub collects skills for cluster work. It is content
only: installing it starts nothing and declares no MCP server. Its skills use
the `modules`, `spack` and `darshan` servers PanCode ships ([PanKit](pankit.md)),
and run the cluster's own programs over `bash` when a server cannot work on
this host. `pancode doctor` shows which of those servers this host can serve.

```bash
pancode hub install plugin:hpc --project
```

Run `/reload hub` in a running session afterward.

| Skill | What it covers |
| --- | --- |
| `hpc-modules` | Finding modules and Spack installs through the `modules` and `spack` servers, planning the loads a script needs, and loading them over `bash` in the shell that uses them |
| `hpc-parallel-io` | Correctness rules and tuning for parallel HDF5 and MPI-IO, checked by readback and Darshan counters |
| `hpc-darshan` | Summarizing a Darshan log through the `darshan` server (`darshan-parser` as the fallback) and naming the counters behind each I/O finding |

Known limits for this release: the Lmod path was checked against fake Lmod
binaries only, not on a live cluster, and the MPI-IO guidance in
`hpc-parallel-io` is compile-checked only.

On an air-gapped login node the pack needs no network of its own. PanCode's
own first-use downloads (the Ruby and C# code map grammars and the HDF5,
NetCDF-4 and Parquet readers) are listed with their pre-seeding paths in
[First-use downloads and air-gapped hosts](installation-and-lifecycle.md#9-first-use-downloads-and-air-gapped-hosts).
