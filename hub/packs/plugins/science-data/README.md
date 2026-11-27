# Science data pack

A skill for reading scientific data without changing it. The skill answers
with PanCode's built-in `data` tool first: structure, CF attributes, hyperslabs and
summary statistics for HDF5, NetCDF and Parquet, plus CSV and JSON, read-only
and with no Python. Only for a question `data` cannot answer (grouped or
filtered aggregates, correlations, hypothesis tests, pivots) does it write a
short read-only h5py, netCDF4, pyarrow or pandas script and run it through
`run_script`. The pack ships one MCP server, `catalog`, to find datasets
outside the project. It is the bundled `server.mjs`, started as
`node server.mjs`, with no dependencies to install. Outside PanCode the skill
also uses the `scidata` and `store` servers.

```bash
pancode hub install plugin:science-data --project
```

Run `/reload hub` in a running session after installing.

## Datasets outside the project

The skill searches the dataset catalogs the operator names in the catalog file
with `catalog_search` and `catalog_describe` (`read`), and brings one resource
into the project with `catalog_stage` (`execute`, `destination` is a write
path), which asks first. A fleet worker reaches a remote portal only after
`pancode mcp trust catalog --network`.

The server reads `$XDG_CONFIG_HOME/science-data/catalog.json`, or
`~/.config/science-data/catalog.json` when `XDG_CONFIG_HOME` is not set, on
every call, so edits apply at once. Without it the server is unavailable and
names the path to create. This file is valid as is; replace the values:

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

The file is read strictly: an unknown field, a duplicate id, or more than 32
sources or 5000 local datasets is refused with its location. A local dataset
needs `id` and `title`; a local resource needs `id` and an absolute `path`. A
`ckan` source needs `id` and the portal's base `url` (the part before
`/api/3/action`), without credentials, query or fragment. Every `ckan` request
goes over https to the source's own host or a host in its `resourceHosts`
(`"allowHttp": true` also permits http), and the server sends no credentials.

## Other harnesses

The pack's `.mcp.json` declares the `catalog` server for Claude Code, and any
other MCP host runs it as a stdio server with `node <pack>/server.mjs`
(Node.js 22 or later). Declare `npx -y -p @panstudio/pancode pankit serve <id>`
(`scidata`, `store`) as a stdio MCP server yourself. The skill's `data` reads
are then the `scidata` server's tools, and its store is the `store` server's,
which needs `--root` options there (`pancode store where` prints them).

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
