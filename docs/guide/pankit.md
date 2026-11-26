# PanKit

PanKit is PanCode's agent toolkit: MCP tool servers for HPC and scientific work that PanCode runs in its sessions and shares with other agents, such as Claude Code and Codex, through one command, `pankit`.

The servers are registered in `SERVERS` in [registry.ts](../../packages/kit/src/registry.ts), the commands are in [cli.ts](../../packages/kit/src/cli.ts), the policy manifest is built by `kitManifest` in [manifest.ts](../../packages/kit/src/manifest.ts), and PanCode loads the servers as its `builtin` MCP scope with `loadMcpBuiltinServers` in [builtin.ts](../../src/domains/gateway/mcp/builtin.ts).

PanKit is the workspace package `@pancode/kit`. It is private and never published on its own: the `@panstudio/pancode` npm package ships it as the `pankit` command, beside `pancode`, together with the policy manifest `packages/kit/servers.json`. Every server speaks the Model Context Protocol over stdio and is built on the [extension API](sdk.md)'s `pancode/sdk/tool` and `pancode/sdk/mcp-server`. The package page is the [PanKit README](https://github.com/PanStudio/pancode/blob/main/packages/kit/README.md).

## Servers

PanKit ships seven servers. Each tool has an action class, the policy a host applies to its calls: `read` tools only read, and `execute` tools change something or run work with side effects. The tables below follow `pankit manifest`; a path argument is one the host judges as a file read or write before it sends the call.

### `node`

This machine's hardware and load. Every fact the platform does not report is null with its reason. `pankit doctor` names the optional sources it found: `/proc`, `lscpu`, `nvidia-smi` and `ps`.

| Tool | Class | Path arguments | Returns |
| --- | --- | --- | --- |
| `node_cpu` | `read` | none | CPU model, architecture, socket, core and thread counts, the threads the process may use, and load averages |
| `node_memory` | `read` | none | Physical memory and swap, in bytes |
| `node_disks` | `read` | none | Mounted file systems (at most 100) with size, free and available bytes and inode counts |
| `node_network` | `read` | none | Hostname and network interfaces with their addresses; no hardware addresses |
| `node_gpus` | `read` | none | NVIDIA GPUs through `nvidia-smi`, with memory in bytes and utilization |
| `node_processes` | `read` | none | The top processes by CPU or memory (at most 50), with the command name and never its arguments |

### `modules`

The site's software modules through Lmod or Environment Modules. The server finds the module tool through `LMOD_CMD`, `MODULES_CMD` or `modulecmd` on `PATH`, which the login shell sets, so start PanCode or the MCP host from a shell where `module avail` works. `modules_avail`, `modules_show` and `modules_spider` make the module tool evaluate site modulefiles with the user's rights, as `module avail` does. Declared environment: `LMOD_*`, `LOADEDMODULES`, `MODULEPATH`, `MODULESHOME`, `MODULES_*`, `_LMFILES_`, `_ModuleTable*`, `__LMOD_*`, `__MODULES_*`.

| Tool | Class | Path arguments | Returns |
| --- | --- | --- | --- |
| `modules_list` | `read` | none | The modules loaded when the server started, in load order |
| `modules_avail` | `read` | none | The modules on `MODULEPATH`, with their source directory and whether each is the default |
| `modules_show` | `read` | none | One module's modulefile path, text and declared changes |
| `modules_spider` | `read` | none | Lmod only: matching modules across the whole hierarchy, and what must be loaded first |
| `modules_plan` | `read` | none | The `module load` lines a batch script needs for 1 to 20 modules; it never loads anything |
| `modules_collections` | `read` | none | The user's saved collections, or the modules one collection loads |

### `darshan`

What one Darshan log says about a job's I/O, read through `darshan-parser` from darshan-util (and `darshan-dxt-parser` for DXT traces), which must be on `PATH`. Every tool takes the log `path`; a counter Darshan did not record is null with its reason.

| Tool | Class | Path arguments | Returns |
| --- | --- | --- | --- |
| `darshan_summary` | `read` | `path` read | The job (executable without its arguments, uid, job id, times, process count), mounts, modules, and per-module bytes, seconds, opens and rate |
| `darshan_files` | `read` | `path` read | The top files of one module, ranked by a chosen counter |
| `darshan_modules` | `read` | `path` read | Every counter of one module, summed over files and ranks |
| `darshan_timeline` | `read` | `path` read | Bytes read and written per time bin, from the heatmap or the DXT trace |

### `spack`

The Spack instance named by `PATH` or `SPACK_ROOT`. No tool installs, uninstalls, loads, fetches or edits configuration. A read tool whose command would clone Spack's package repository returns the `spack repo update` command to run once instead. Declared environment: `SPACK_DISABLE_LOCAL_CONFIG`, `SPACK_ENV`, `SPACK_PYTHON`, `SPACK_ROOT`, `SPACK_SYSTEM_CONFIG_PATH`, `SPACK_USER_CACHE_PATH`, `SPACK_USER_CONFIG_PATH`.

| Tool | Class | Path arguments | Returns |
| --- | --- | --- | --- |
| `spack_find` | `read` | none | Installed specs with hash, compilers, prefix and whether each was installed explicitly |
| `spack_info` | `read` | none | One package's versions, variants, dependencies and licenses |
| `spack_locate` | `read` | none | The prefix of an installed spec, or a package's recipe directory |
| `spack_spec` | `execute` | none | How a spec concretizes and which nodes are already installed; a first concretization can bootstrap Spack's solver into Spack's user directories |
| `spack_env` | `read` | none | The active and named environments, with their root specs and install status |

### `scidata`

The structure, a bounded slice and summary statistics of a data file: CSV, TSV, JSON, JSON Lines, HDF5, NetCDF (classic and NetCDF-4), Zarr v2 and v3, Parquet, and ADIOS2 BP4 and BP5 metadata. It reads through the same code as PanCode's `data` tool, so the answers match. Every result is at most 256 KiB of JSON; a larger one is a tool error that names the argument to narrow it with.

| Tool | Class | Path arguments | Returns |
| --- | --- | --- | --- |
| `scidata_inspect` | `read` | `path` read | Format, groups, variables or columns with types, shapes and attributes, and a bounded sample |
| `scidata_select` | `read` | `path` read | Rows of a table, a value of a JSON document, or a hyperslab of one array variable, as stored |
| `scidata_stats` | `read` | `path` read | Count, minimum, maximum, mean, standard deviation and NaN, fill and missing counts of one variable or column |

### `catalog`

The dataset catalogs the operator names in a catalog file: datasets listed in the file itself (`local` sources) and public CKAN portals (`ckan` sources). Without a catalog file the server is unavailable and says which path to create.

| Tool | Class | Path arguments | Returns |
| --- | --- | --- | --- |
| `catalog_search` | `read` | none | One bounded list of matching datasets across every source, with each source's own status |
| `catalog_describe` | `read` | none | One dataset's resources with size, URL or path, and SHA-256 when the catalog gives one |
| `catalog_stage` | `execute` | `destination` write | Copies or downloads one resource to `destination` and returns its SHA-256, checked against the catalog's when known |

### `store`

A project's [PanStore](panstore.md): its tags, blobs, records and read-only copies. Unavailable until started with `--root`; `store_put` and `store_note` write only into the tags the server was started with `--write-tag` for, and record the actor `mcp`. No tool removes anything.

| Tool | Class | Path arguments | Returns |
| --- | --- | --- | --- |
| `store_tags` | `read` | none | The tags with blob counts, bytes and root |
| `store_list` | `read` | none | One tag's blobs, with bytes, time and whether each has a record |
| `store_stat` | `read` | none | One blob's bytes, SHA-256, root, drift and records |
| `store_get` | `read` | none | The path of a read-only copy of one blob, never its content |
| `store_history` | `read` | none | The records of one blob or of a whole tag, newest first |
| `store_put` | `execute` | `source` read | Puts the file at `source` into a tag and records the put |
| `store_note` | `execute` | none | Adds a note to one blob's records |

## Commands

```bash
pankit serve <server> [options...]  # serve one server over MCP stdio; stdout carries protocol frames only
pankit serve <server> --help        # the options one server takes
pankit list [--json]                # the servers, their titles and tool counts
pankit doctor [--json]              # whether each server can run on this host, and why not
pankit manifest                     # the policy manifest: every tool's class, path arguments and listed surface
pankit catalog --example            # a valid catalog file for the catalog server
pankit --version
```

Exit codes are 0 for success, 1 for an operational failure and 2 for a usage error.

| Command | Exit codes |
| --- | --- |
| `pankit` with no command | 2, with the help on stderr |
| `pankit serve <server>` | 0 when the client closes the connection; 2 for an unknown server (stderr lists the registered ones), for an option the server refuses, or for any option to a server that takes none; 1 when the server cannot load or its options cannot be applied |
| `pankit serve <server> --help`, or `--help` after `serve` with no server | 0, with the usage on stdout |
| `pankit list` | 0; 1 when a server cannot load |
| `pankit doctor` | 0 whether or not each server is available; 1 when a server's probe fails |
| `pankit manifest` | 0; 1 when the manifest cannot be built |

`pankit doctor` prints one line per server, `<id>: available` or `<id>: unavailable: <reason>`, followed by the sources it looked for and whether each was found. `pankit doctor --json` adds each source's detail, such as the path a missing `scidata` reader would be copied to. The probe starts no server.

`pankit manifest` prints the same JSON as `packages/kit/servers.json`: for each server its id, version, title and declared `environment`, and for each tool its `actionClass`, `pathArguments`, input schema and annotations.

## Server configuration

Options follow the server id: `pankit serve <server> [options...]` hands everything after the id to that server once, before it serves. Options decide what a call may reach, never which tools exist, so a server's tools and its `pankit manifest` entry are the same whatever options it is given. `node`, `modules`, `darshan` and `spack` take no options.

A server that needs variables from its caller's environment names them in the `environment` field of its manifest entry: a variable name, or a prefix of at least four characters followed by `*`. MCP hosts usually start a server with a minimal environment, so a host should pass those names through.

### `scidata` options

`pankit serve scidata [--cache <dir>]`. CSV, TSV, JSON, JSON Lines, classic NetCDF and Zarr need nothing beyond the package. HDF5, NetCDF-4 and Parquet are read by pinned npm packages (`h5wasm` 0.10.3 and `hyparquet` 1.31.5) that the server fetches from the npm registry on first use, checks against their pinned hashes and keeps in the reader cache: `$XDG_CACHE_HOME/pankit/data-readers`, or `~/.cache/pankit/data-readers` when `XDG_CACHE_HOME` is unset or not absolute. `--cache <dir>` uses `<dir>` instead.

On a host without registry access, pre-seed the cache: copy each tarball to `<cache>/<name>@<version>/<name>-<version>.tgz`, for example `https://registry.npmjs.org/h5wasm/-/h5wasm-0.10.3.tgz` to `<cache>/h5wasm@0.10.3/h5wasm-0.10.3.tgz`. `pankit doctor --json` gives the exact URL and path for each missing reader. When a fetch fails, the call is a tool error that names that path, and the server does not try again for ten minutes. The fetch ignores `HTTPS_PROXY` and `NO_PROXY`, so a host behind a proxy pre-seeds the cache.

### `catalog` options

The server reads one catalog file: `$XDG_CONFIG_HOME/pankit/catalog.json`, or `~/.config/pankit/catalog.json` when `XDG_CONFIG_HOME` is not set, or the path given with `pankit serve catalog --file <path>` (relative to the working directory). The file is read on every call, so edits apply at once. `pankit catalog --example` prints this file, which is valid as is:

```json
{
	"version": 1,
	"sources": [
		{
			"id": "site",
			"type": "local",
			"datasets": [
				{
					"id": "climate-2024",
					"title": "Regional climate runs 2024",
					"description": "Daily fields, 12 km grid.",
					"tags": ["climate", "netcdf"],
					"license": "CC-BY-4.0",
					"updated": "2024-05-01T12:00:00Z",
					"resources": [
						{ "id": "tas", "name": "tas_day.nc", "format": "NetCDF", "path": "/data/climate/tas_day.nc", "sha256": null }
					]
				}
			]
		},
		{
			"id": "open",
			"type": "ckan",
			"url": "https://catalog.example.org",
			"resourceHosts": ["files.example.org"]
		}
	]
}
```

The file is read strictly: an unknown field, a duplicate id, or more than 32 sources or 5000 local datasets is refused with its location, such as `sources[1].id: duplicate source id site`. A local dataset needs `id` and `title`; a local resource needs `id` and an absolute `path`. A `ckan` source needs `id` and the portal's base `url` (the part before `/api/3/action`), without credentials, query or fragment.

Network rules for a `ckan` source:

- Every request, API call or download, goes over https to the source's own host or to a host listed in its `resourceHosts` (`host` or `host:port`). A resource on any other host is refused before it is requested, and the refusal names the host and the `resourceHosts` entry that would allow it.
- The server follows redirects itself, at most 5, and checks each hop the same way before requesting it. Many portals redirect a download to an object-storage host; listing that host in `resourceHosts` allows it. The `finalUrl` a stage reports drops the redirect target's query and fragment, which can carry a signed, short-lived credential.
- `"allowHttp": true` on a source also permits plain http, for a portal on a trusted network.
- The server reads, stores and sends no credentials, cookies or API keys.
- Failures report the HTTP status or the timeout, never the response body. An API call is bounded at 20 seconds, and a download stops when no data arrives for 60 seconds.

### `store` options

```bash
pankit serve store --root [<name>=]<dir> [--root <name>=<dir> ...] [--cache <dir>] [--project <dir>] [--project-id <id>] [--write-tag <tag> ...]
```

The first `--root` is the primary root, named `default` unless given as `<name>=<dir>`; each further root is `<name>=<dir>`. `--project` is any directory of the project and defaults to the directory the server starts in. `--project-id` is the project's `store.projectId`: it keys the store by that id, so every checkout of the project on every host reaches the same store; without it the store is keyed by the project's path. `--cache` is where `store_get` keeps its read-only copies and defaults to `~/.cache/panstore`; the server reads no variables, so it does not follow `XDG_CACHE_HOME`. `pancode store where` prints the `--root`, `--cache`, `--project` and `--project-id` options that reach the store PanCode uses for a project.

Each `--write-tag <tag>` lets `store_put` and `store_note` write that tag and the tags nested under it (`--write-tag results` allows `results` and `results/run1`). A write into any other tag is refused, naming the tags allowed, before the source file is opened. Without one the server writes nothing. Reads are not confined: every tag of the project can be read. A read also refuses when the primary root does not exist, so a mistyped `--root` is never read as an empty store.

## PanKit inside PanCode

PanCode lists every PanKit server as a `builtin` MCP server. A builtin server is trusted by authorship: its tools and their classes come from the manifest this PanCode ships, its surface is approved while it serves that policy, and it needs no `pancode mcp trust`. A user declaration with the same id overrides it, with a warning; a project or plugin declaration with the same id is shadowed. PanCode starts a builtin server with exactly the variables its manifest entry declares, taken from the environment PanCode was started in.

```bash
pancode mcp list                         # every server, its scope, trust, classes and surface
pancode mcp test node --call node_memory # start one server, list its tools, make a call, stop it
pancode mcp trust catalog --network      # let a builtin server reach the network in fleet workers
pancode mcp untrust catalog              # remove that grant
```

`pancode mcp list` prints a line such as `node scope=builtin command=[...] cwd=... trust=trusted actionClass=read toolActionClasses=node_cpu:read,...` for each server, then its tools as `mcp_<server>__<tool>` with their classes and the line `surface=approved <digest>`. `pancode mcp test <id>` prints the protocol version, server, tool count and network grant, then each call's result, and exits 1 when the server fails or a call returns an error.

PanCode adds launch options to three builtin servers. They name this PanCode home and this project, so they stay out of the server's declaration and its digest:

- `scidata` gets `--cache <PanCode cache>/pankit/data-readers`.
- `catalog` gets `--file <PanCode config>/pankit/catalog.json`, which is `~/.config/pancode/pankit/catalog.json` unless `PANCODE_CONFIG_DIR` or `PANCODE_HOME` moves it. An isolated PanCode home never reads the operator's own `~/.config/pankit/catalog.json`.
- `store` gets the session's store: `--root` for each store root in settings order, primary first, `--cache` for PanCode's cache directory, `--project` for the directory it starts in, `--project-id` when the project's tracked settings set `store.projectId`, and one `--write-tag` per tag the session may write. The main session and `pancode mcp test` write every tag the project's store lists, a fleet worker exactly the tags its dispatch granted, and any other session none. See [MCP servers and store references](panstore.md#mcp-servers-and-store-references).

The other four servers get no options. `pancode doctor` runs `pankit doctor` once with the same launch environment and prints one `pankit <id>` row per server, naming the catalog file and reader cache a session uses.

In a sandboxed fleet worker a server starts without network. `pancode mcp trust <id> --network` on a builtin server records the one decision an operator makes for it: a network grant keyed by the server id, which holds in every project and survives an upgrade. Any other `trust` on a builtin server is refused, and `pancode mcp untrust <id>` removes the grant. `safety.sandboxNetwork: true` also opens the network for every worker. A worker whose write roots overlap the directory a builtin server starts in (the project) or its entry script starts that server without its grant; read-only workers and workers that write only in their own worktree keep it. See [MCP tools in native workers](fleet-dispatch.md#mcp-tools-in-native-workers) and [local stdio MCP configuration and trust](configuration-reference.md#local-stdio-mcp-configuration-and-trust).

## PanKit in another MCP host

A host launches `pankit serve <server>` as a stdio server. Without a global install, `npx -y -p @panstudio/pancode pankit serve <server>` fetches the `@panstudio/pancode` package and runs its `pankit`. For a host that reads the common `mcpServers` shape:

```json
{
	"mcpServers": {
		"node": { "command": "npx", "args": ["-y", "-p", "@panstudio/pancode", "pankit", "serve", "node"] },
		"scidata": { "command": "pankit", "args": ["serve", "scidata", "--cache", "/scratch/pankit-readers"] }
	}
}
```

Use `"command": "pankit"` when `pankit` is on the host's `PATH`, or the absolute path to the installed `pankit`. Pass the variables a server's manifest entry declares through to it.

To run a server with options from PanCode, such as `store` with your own roots, declare it under another id as a user server in `<config>/mcp.yaml`:

```yaml
version: 1
servers:
  - id: kit-store
    command: pankit
    args: [serve, store, --root, /path/to/root, --project, /path/to/project, --write-tag, results]
```

A user server is trusted by the operator who wrote it, and its tools are callable once its surface is recorded: an attended session records it on its first listing, or review it with `pancode mcp trust kit-store --surface` and approve it with the `--hash` that command prints. PanCode does not take a user server's classes from the server, so set `actionClass` or `toolActionClasses`; `store_put` and `store_note` are `execute`.

## Policy belongs to the host

A server's own description of its tools (the read-only, destructive and idempotent hints, and the action class it reports) is a hint, and each host decides the policy it enforces. `pankit manifest` prints the policy PanCode ships for these servers, generated from the tool definitions, so another host can review and adopt it. PanCode applies that shipped policy to its builtin servers, never the classes a running server reports.

## Limits

- `catalog` ships no sources: without a catalog file the server is unavailable. It reads public CKAN portals only, with no credentials, so private datasets are not reachable. It has no proxy support, so a host that reaches the internet only through a proxy cannot use `ckan` sources. It downloads only from the source's own host or a host the operator listed in `resourceHosts`.
- `scidata` keeps its own reader cache, separate from the one PanCode's `data` tool uses, so the HDF5 and Parquet readers download twice. The reader fetch ignores proxy settings.
- `scidata` has no SQLite reader and no `validate`; both stay in PanCode's `data` tool.
- `spack_spec` is classed `execute`, because a first concretization can clone Spack's package repository and bootstrap its solver.
- No `modules` tool loads a module: `modules_plan` writes the `module load` lines for a script, and `modules_list` reports the modules loaded when the server started.
- `node_gpus` reports NVIDIA GPUs only, through `nvidia-smi`.
- The `store` server's reads are not confined to its write tags; see [PanStore limits](panstore.md#limits).
- A fleet worker that may write the project starts a builtin server without its network grant, so a server that needs the network fails there.
- PanKit servers on macOS and Windows are unverified. The release boot on those platforms installs the package and runs `pancode --version`, `pancode --help`, `pankit list` and one `pankit serve node` handshake; no server's tools are called there.
