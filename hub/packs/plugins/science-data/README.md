# Science data pack

A skill for reading scientific data without changing it. The skill answers
with PanCode's built-in `data` tool first: structure, CF attributes, hyperslabs and
summary statistics for HDF5, NetCDF and Parquet, plus CSV and JSON, read-only
and with no Python. Only for a question `data` cannot answer (grouped or
filtered aggregates, correlations, hypothesis tests, pivots) does it write a
short read-only h5py, netCDF4, pyarrow or pandas script and run it through
`run_script`. Installing the pack launches nothing. The pack declares no MCP
server; it uses the `catalog` server PanCode ships to find datasets outside the
project (and the `scidata` and `store` servers outside PanCode), and
`pancode doctor` shows whether this host can serve them.

```bash
pancode hub install plugin:science-data --project
```

Run `/reload hub` in a running session after installing.

## Datasets outside the project

The skill searches the dataset catalogs the operator names in PanCode's catalog
file with `catalog_search` and `catalog_describe`, and brings one resource into
the project with `catalog_stage`, which asks first. Without a catalog file the
server is unavailable and names the path to create; `pancode mcp serve catalog
--help` prints a valid file. A fleet worker reaches a remote portal only after
`pancode mcp trust catalog --network`.

## Other harnesses

Declare `npx -y -p @akougkas/pancode pancode mcp serve <id>` (`catalog`, `scidata`, `store`)
as a stdio MCP server yourself. The skill's `data` reads are then the
`scidata` server's tools, and its store is the `store` server's, which serves
the store of the project it starts in and writes only the tags named with
`--write-tag` (`pancode store where` prints the full command line).

## Datasets and results in the store

The skill starts from the `store`: it lists tags, takes a dataset's path with
`get` rather than searching the working tree, and reports when a blob changed
since it was recorded or was never recorded. Results worth keeping are made
with `run_script`, declaring inputs and outputs, then put into an `output` tag
with a note, so each one names the run and inputs that produced it. Seed a tag
from the shell with `pancode store put <tag> <file>`.

## Read-only by default

The `data` tool is read-only and runs without asking. A `run_script` step opens
each file in read mode, declares it in `inputs`, and records the command and the
file's hash.

## Offline behavior

The pack makes no network calls of its own. A catalog search reaches only the
sources the catalog file names; a `local` source needs no network. The `data`
tool's HDF5 and Parquet readers download once from the npm registry on first use and are cached;
offline with a cold cache it refuses and names the cache path. A `run_script`
fallback needs h5py, netCDF4, pyarrow or pandas already installed in the
project's Python environment.

## Licenses and terms

The pack is under the PanCode License 1.0 and bundles no code or data. It names
no external data service; a portal the operator adds to the catalog file keeps
its own data terms of use. The Python libraries a fallback script
imports keep their own licenses.
