# PanKit for Claude Code

This pack gives Claude Code six of PanKit's MCP servers. PanKit is PanCode's agent toolkit: tool servers for HPC
and scientific work. Each server here is a stdio MCP server that Claude Code starts with
`npx -y -p @akougkas/pancode pankit serve <id>`.

```bash
claude plugin marketplace add akougkas/pancode
claude plugin install pankit@pancode
```

`claude plugin update pankit@pancode` updates the pack and `claude plugin uninstall pankit@pancode` removes it.

| Server | What it answers |
| --- | --- |
| `node` | This machine's CPU topology and load, memory and swap, mounted file systems, network interfaces, NVIDIA GPUs and top processes. |
| `modules` | The site's software modules through Lmod or Environment Modules, and the `module load` lines a batch script needs. |
| `darshan` | What one Darshan log says about a job's I/O, through `darshan-parser`. |
| `spack` | The Spack instance on `PATH` or `SPACK_ROOT`: installed specs, package recipes, prefixes, concretization and environments. |
| `scidata` | The structure, a bounded slice and statistics of CSV, TSV, JSON, HDF5, NetCDF, Zarr and Parquet files. |
| `catalog` | The dataset catalogs the operator names in a catalog file, local and public CKAN, and staging one resource. |

`pankit doctor` reports whether each server can run on this host and why not; `pankit catalog --example` prints a
valid catalog file for the `catalog` server.

## Versions and downloads

The command names no version. On the first launch npx downloads the version of `@akougkas/pancode` npm resolves
then (51 MB unpacked for 0.9.0) and later launches reuse its cache. With PanCode installed, `pankit` is already on
`PATH`; a server entry of `{"command": "pankit", "args": ["serve", "<id>"]}` added by hand runs the installed
version instead.

## The store server

`store` is not in this pack: it serves one project's PanStore and needs a `--root` for it. In that project, run
`pancode store where`. Its last line is the `pankit serve store` command with the `--root`, `--cache`, `--project`
and `--project-id` options for that store; add it to Claude Code with

```bash
claude mcp add store -- npx -y -p @akougkas/pancode pankit serve store --root <dir> --cache <dir> --project <dir>
```

using the options that line prints. Without a `--write-tag` option the server only reads.

## In PanCode

PanCode reads a pack's `mcp.json`, never `.mcp.json`, so installing this pack in PanCode declares nothing. PanCode
already has all seven servers as `builtin` MCP servers; `pancode mcp list` shows them.
