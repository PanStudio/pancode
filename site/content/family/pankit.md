PanKit is a suite of MCP tool servers for HPC and scientific work. Every server speaks the Model Context Protocol over stdio, so any MCP host can run it, and PanCode reaches the same servers through its MCP gateway as `builtin` servers. One command, `pankit`, lists, checks and serves them.

## The seven servers

| Server | What it answers |
| --- | --- |
| `node` | This machine's CPU, memory, disks, network interfaces, NVIDIA GPUs and top processes, all read-only. |
| `modules` | The site's software modules through Lmod or Environment Modules, and the `module load` lines a batch script needs. |
| `spack` | Installed Spack specs, package details, prefixes, concretization and environments. It never installs anything. |
| `darshan` | What one Darshan log says about a job's I/O: per-module totals, top files and a timeline. |
| `scidata` | The structure, a bounded slice and summary statistics of HDF5, NetCDF, Zarr, Parquet, CSV and JSON files. |
| `catalog` | Search, describe and stage datasets from the catalogs an operator lists, including public CKAN portals. |
| `store` | A project's [PanStore](/panstore.html): tags, blobs, records, and writes only to the tags it was started with. |

## Install

PanKit ships with PanCode. Installing PanCode, with the installer or from npm, also installs the `pankit` command.

```bash
curl -fsSL https://pancode.dev/install.sh | sh
npm install -g @akougkas/pancode   # or, with Node.js 22.19 or newer
```

## Example

Check which servers can run on this host, then serve one over stdio:

```bash
pankit doctor
pankit serve node
```

An MCP host that reads the common `mcpServers` shape can start a server without a global install:

```json
{
	"mcpServers": {
		"node": { "command": "npx", "args": ["-y", "-p", "@akougkas/pancode", "pankit", "serve", "node"] }
	}
}
```

## Limits

::: limits What PanKit does not do
- `catalog` ships no sources and reads public CKAN portals only, without credentials or proxy support.
- No `modules` tool loads a module, and `node_gpus` reports NVIDIA GPUs only.
- PanKit servers on macOS and Windows are unverified beyond one `pankit serve node` handshake.
- The full list is in [the guide's limits](/docs/guide/pankit.html#limits).
:::

## Learn more

::: next Learn more
- [Tool servers with PanKit](/docs/guide/pankit.html)
- [The PanKit package and its source](../../../packages/kit/README.md)
- [@akougkas/pancode on npm](https://www.npmjs.com/package/@akougkas/pancode)
:::
