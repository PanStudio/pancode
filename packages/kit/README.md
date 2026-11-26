# PanKit

PanKit is PanCode's agent toolkit: MCP tool servers for HPC and scientific work, covering software modules, Spack packages,
node facts, I/O traces, scientific file formats, dataset catalogs and the project store. It is one package with
one command, `pankit`, and every server speaks the Model Context Protocol over stdio, so Claude Code, Codex or any
other MCP host can run it.
PanCode reaches the same servers through its MCP gateway as `builtin` servers.

PanKit ships inside the `@akougkas/pancode` npm package, which installs `pankit` beside `pancode`. This workspace package,
`@pancode/kit`, is private and never published on its own.

## Install

`pankit` ships in the `@akougkas/pancode` npm package and needs Node 22.19 or later.

```bash
npm install -g @akougkas/pancode      # installs pancode and pankit
pankit list
```

Without a global install, `npx -y -p @akougkas/pancode pankit <command>` fetches the package and runs `pankit`.

## Example

Serve the `node` server to any MCP host that reads the common `mcpServers` shape:

```json
{
	"mcpServers": {
		"node": { "command": "pankit", "args": ["serve", "node"] }
	}
}
```

When `pankit` is not on the host's `PATH`, use `"command": "npx"` with
`"args": ["-y", "-p", "@akougkas/pancode", "pankit", "serve", "node"]`, or the absolute path to the installed `pankit`.
Inside PanCode the servers are already there as `builtin` servers: `pancode mcp list` shows them and
`pancode mcp test node --call node_memory` calls one.

## Servers

| Server | Tools | What it answers |
| --- | --- | --- |
| `node` | `node_cpu`, `node_memory`, `node_disks`, `node_network`, `node_gpus`, `node_processes` | This machine's CPU topology and load, memory and swap, mounted file systems, network interfaces, NVIDIA GPUs and top processes. |
| `modules` | `modules_list`, `modules_avail`, `modules_show`, `modules_spider`, `modules_plan`, `modules_collections` | The site's software modules through Lmod or Environment Modules, and the `module load` lines a batch script needs. |
| `darshan` | `darshan_summary`, `darshan_files`, `darshan_modules`, `darshan_timeline` | What one Darshan log says about a job's I/O, through `darshan-parser`. |
| `spack` | `spack_find`, `spack_info`, `spack_locate`, `spack_spec`, `spack_env` | The Spack instance on `PATH` or `SPACK_ROOT`: installed specs, package recipes, prefixes, concretization and environments. |
| `scidata` | `scidata_inspect`, `scidata_select`, `scidata_stats` | The structure, a bounded slice and statistics of CSV, TSV, JSON, HDF5, NetCDF, Zarr and Parquet files. |
| `catalog` | `catalog_search`, `catalog_describe`, `catalog_stage` | The dataset catalogs the operator names in a catalog file, local and public CKAN, and staging one resource. |
| `store` | `store_tags`, `store_list`, `store_stat`, `store_get`, `store_history`, `store_put`, `store_note` | A project's PanStore: tags, blobs, records and read-only copies, with writes only into allowed tags. |

Every tool's action class and path arguments are in `pankit manifest`, and the guide lists them per server.

## Commands

```bash
pankit serve <server> [options...]  # serve one server over MCP stdio; stdout carries protocol frames only
pankit serve <server> --help        # the options one server takes
pankit list [--json]      # the servers, their titles and tool counts
pankit doctor [--json]    # whether each server can run on this host, and why not
pankit manifest           # the policy manifest: every tool's class, path arguments and listed surface
pankit catalog --example  # a valid catalog file for the catalog server
pankit --version
```

Exit codes: 0 success, 1 operational failure, 2 usage error. Options follow the server id: `scidata` takes
`--cache <dir>`, `catalog` takes `--file <path>`, `store` takes `--root`, `--cache`, `--project`, `--project-id`
and `--write-tag`, and the other servers take none. A server that reads variables from its caller's environment names
them in the `environment` field of its manifest entry; pass those through.

## Policy belongs to the host

A server's own description of its tools (the read-only, destructive and idempotent hints, and the action class
it reports) is a hint, and each host decides the policy it enforces. `pankit manifest` prints the policy PanCode
ships for these servers, generated from the tool definitions, so another host can review and adopt it.

## Limits

The catalog server ships no sources and reads public CKAN portals only, without proxy support; `scidata` keeps its
own reader cache and has no SQLite reader; `spack_spec` is classed `execute`; no `modules` tool loads a module; and
the servers are unverified on macOS and Windows. The full list is in
[the guide's Limits](https://pancode.dev/docs/guide/pankit.html#limits).

## Documentation

- PanKit guide, with every tool, server configuration and PanCode integration: https://pancode.dev/docs/guide/pankit.html
- The extension API (unstable), which the servers are built on: https://pancode.dev/docs/guide/sdk.html
- Source: https://github.com/akougkas/pancode/tree/main/packages/kit
- PanCode: https://github.com/akougkas/pancode
