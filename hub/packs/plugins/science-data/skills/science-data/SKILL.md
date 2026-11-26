---
name: science-data
description: "Finds and explores scientific data: where is the data, which dataset a store tag holds or a data catalog lists, and how to keep results with provenance. Reads HDF5, NetCDF, Parquet and CSV read-only with PanCode's data tool for structure, slices and summary statistics, and a read-only h5py, netCDF4, pyarrow or pandas script only for what it cannot do. Not for converting data files."
triggers:
  - what variables are in the simulation output
  - where is the data
  - find a dataset in the catalog
  - which dataset holds the results
  - what is in this data file
  - list the columns and fields
  - summarize the simulation results
  - keep the results in the store
---

# Scientific data, one tool at a time

Answer questions about a data file without changing it, and use the lightest
tool that can answer. The second step costs more: a Python environment and a
recorded script run. Never write to a data file to answer a
question about it. Pass absolute file paths. Inside PanCode, the `store`
capability and the `data` tool come first: they are the same libraries as the
`store` and `scidata` servers, and `store` carries this session's roots.

## Where data lives: the store

The `store` capability holds this project's datasets and results outside the
working tree, as tags of named blobs, and records how each blob was made.
Call it with `gateway(op="call", capability="store", args={...})`.

- Start with `op="tags"`. If a tag's description names the dataset, list it,
  `op="get"` the blob and pass the returned path unchanged to the tools below.
  Do not search the working tree for data a tag already holds.
- Read `drift` and the producing run in `op="stat"`. When `drift` is not
  `none`, or the blob has no producing run on record, say so in the answer.
- Make anything worth keeping with `run_script`, declaring its `inputs` and
  `outputs`, then `op="put"` the output with a one-line `note`. A file made
  with `bash` has no producing run on record.
- A store blob goes into `run_script` as itself: declare it in `inputs` as
  `<tag>:<blob>` (or the path `op="get"` returned) and pass the same string
  in `args`; the script receives the blob's readable path. Never copy a blob
  into the working tree. The put's record then names the blob it used, such
  as `sim:run042.h5`, with its hash.
- Keep intermediates in a tag of class `cache` and results in a tag of class
  `output` (`op="create"` with `class` and a `description`).
- When dispatching workers on data, name each blob as `<tag>:<blob>` in the
  task text, and grant the output tag with the dispatch's `tags` so the
  worker can put its results there. Without a grant the worker reads the
  store and the dispatching session puts results.
- Never `op="remove"` a blob to make room unless the user asked. Say what is
  large instead.
- With no tags, say so, and name `op="create"` and `pancode store put` as
  the ways to add data.

## Finding a dataset outside the project

When neither the working tree nor a store tag holds the data, look in the
dataset catalogs the operator named, through the `catalog` server PanCode
ships. Call a tool by its capability name; when it is not attached to the
session, call it through
`gateway(op="call", capability="mcp_catalog__catalog_search", args={...})`.

1. `mcp_catalog__catalog_search` with `query` (words that must all appear in a
   title, description or tags; `source` narrows to one source). Each source
   reports its own status; quote a source that failed.
2. `mcp_catalog__catalog_describe` with the `source` and `id` a search
   returned lists the dataset's resources with size, path or URL, and SHA-256
   when the catalog gives one.
3. `mcp_catalog__catalog_stage` with `source`, `dataset`, `resource` and a
   `destination` inside the project copies or downloads one resource and
   returns its SHA-256. It is `execute`, so it asks first. Then read it with
   the tools below, or `op="put"` it into a store tag.

With no catalog file the server is unavailable, and its reason names the path
to create (`pankit catalog --example` prints a valid file): say so and stop.
In a fleet worker the `catalog` server reaches a remote portal only after the
operator runs `pancode mcp trust catalog --network`.

## 1. The `data` tool first

`gateway(op="call", capability="data", args={...})` is built in, read-only,
bounded, and needs no Python and no approval. It covers:

- `op="inspect"` on HDF5, NetCDF (classic and NetCDF-4), Parquet, CSV/TSV,
  JSON, JSON Lines and SQLite. For a scientific file it gives the group and
  variable tree, dtype, shape, dimensions, attributes with their CF metadata
  (`units`, `_FillValue`, `scale_factor` and the rest), chunking and
  compression. For Parquet it gives the schema, row groups and footer
  statistics. Use `variable` to narrow to one dataset or group.
- `op="select"` reads a hyperslab (`variable`, `start`, `count`, `stride`; at
  most 2000 elements) or a Parquet row window (`offset`, `limit` up to 1000,
  `columns`). Values come back raw, with `scale_factor` and `add_offset` not
  applied. Say so when you quote them.
- `op="stats"` gives min, max, mean, std and the NaN, infinity, fill and
  missing counts over a selection. It streams up to `max_bytes` and says when
  that cap cut the scan short.

The HDF5 and Parquet readers download once from the npm registry on first use,
pinned and cached. Offline with a cold cache, the refusal names the URL and the
cache path: say that, and go to step 2.

## 2. h5py, netCDF4, pyarrow or pandas through `run_script`, last

When `data` cannot answer, for example a grouped or filtered aggregate, a
correlation, a statistical test, or a reader that is offline and not cached,
write a short read-only script that opens the file in read mode (`"r"`)
and run it with `run_script`, declaring the file in `inputs` (a store blob as
`<tag>:<blob>`). That records the command and the file's hash. Never open the file in a writable mode.

## Other harnesses

Outside PanCode there is no `data` tool or `store` capability. The same reads
are the `scidata` server's `mcp_scidata__scidata_inspect`,
`mcp_scidata__scidata_select` and `mcp_scidata__scidata_stats`, from the same
library as `data`, and the store is the `store` server's tools
(`mcp_store__store_tags`, `mcp_store__store_get`, `mcp_store__store_put` and
the rest), which there need `--root` options; `pancode store where` prints
them. Declare each as `npx -y -p @panstudio/pancode pankit serve <id>`.

## Final answer

Name each file (and the catalog source and dataset it came from), the
dataset paths or columns, the slice, and the tool that read it. Quote the units an attribute declares, and say when there are none. Report
each statistic with the call that produced it, and say when a scan was capped
or values are raw.
