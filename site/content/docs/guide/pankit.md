# Tool servers with PanKit

Run PanKit's MCP tool servers in PanCode or in any other MCP host.

## What PanKit gives you

PanKit is a suite of MCP tool servers for HPC and scientific work. The `pancode` package installs it as the `pankit` command. PanCode loads every server as a builtin MCP server, and any other MCP host can launch one with `pankit serve <server>`.

| Server | What it answers |
| --- | --- |
| `node` | This machine's CPU, memory, disks, network interfaces, NVIDIA GPUs and top processes, read-only. |
| `modules` | The site's software modules, and the `module load` lines a batch script needs. |
| `spack` | Installed Spack specs, package details, prefixes, concretization and environments. |
| `darshan` | What one Darshan log says about a job's I/O. |
| `scidata` | The structure, a bounded slice and summary statistics of HDF5, NetCDF, Zarr, Parquet, CSV and JSON files. |
| `catalog` | Search, describe and stage datasets from the catalogs an operator lists. |
| `store` | A project's [PanStore](/docs/guide/panstore.html) tags and blobs, writing only to the tags it was started with. |

Each tool has an action class: `read` tools only read, and `execute` tools change something or run work with side effects.

## Check what runs on this host

```sh
pankit list
pankit doctor
pankit manifest
```

`doctor` prints `<id>: available` or `<id>: unavailable: <reason>` for each server and starts none of them. `manifest` prints every tool's class and path arguments, the policy PanCode ships for these servers.

## Use the servers inside PanCode

PanKit servers are trusted by authorship: their classes come from the shipped manifest, and they need no `pancode mcp trust`. List them and call one tool:

```sh
pancode mcp list
pancode mcp test node --call node_memory
```

PanCode starts `scidata` with its reader cache, `catalog` with `pankit/catalog.json` in your PanCode config folder, and `store` with the session's store and the tags the session may write. A sandboxed fleet worker starts a server without network until you grant it once, for example `pancode mcp trust catalog --network`.

## Use them from another MCP host

A host launches a server over stdio. Without a global install, `npx` fetches the `pancode` package and runs its `pankit`:

```json
{
	"mcpServers": {
		"node": { "command": "npx", "args": ["-y", "-p", "pancode", "pankit", "serve", "node"] }
	}
}
```

A server's own description of its tools is a hint; each host decides the policy it enforces. Another host can review and adopt the output of `pankit manifest`.

## Limits

- `catalog` ships no sources and reads public CKAN portals only, with no credentials and no proxy support.
- `scidata` keeps its own reader cache, separate from PanCode's `data` tool, and has no SQLite reader.
- No `modules` tool loads a module, and `node_gpus` reports NVIDIA GPUs only.
- A fleet worker that may write the project starts a builtin server without its network grant.
- PanKit servers on macOS and Windows are unverified beyond one `pankit serve node` handshake.
