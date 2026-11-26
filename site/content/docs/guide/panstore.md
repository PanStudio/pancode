# Keep results in PanStore

Keep datasets and results outside the working tree, with a record of where each came from.

## Keep results out of your working tree

Long analyses produce files you want to keep but not commit: datasets, model outputs, figures. PanStore, the project store, holds them outside the working tree. The main session, its workers and every linked worktree of the project see the same store, and each file keeps a record of where it came from.

A tag is a named container, classed input, output, cache or archive. A blob is a file in a tag. A reference reads `<tag>:<blob>`, such as `results:summary.parquet`.

## Store a file from your shell

```sh
pancode store put results out/summary.parquet --note "baseline run"
pancode store tags
pancode store ls results
pancode store stat results:summary.parquet
```

`put` creates a missing tag as an input tag. `stat` shows the record and whether the bytes have drifted since: `none`, `changed`, `missing` or `unrecorded`. `get` prints the path of a read-only copy, or copies the blob elsewhere with `--to <path>`. Every command takes `--json`. `pancode store where` prints the store's folders and ends with the `pankit serve store` line that serves this store over MCP to another agent on this machine.

## Ask PanCode to use it

> Run the analysis script on `data:measurements.h5`, put its summary into the `results` tag, and tell me whether the stored baseline has drifted.

The agent reaches the store through its `store` tool. Reads run without asking. Creating a tag, a put and a note are judged as writes. Removing a blob, or a put that replaces one, asks first and names the blob; a replacing put also states its size. The store keeps no earlier versions.

When a `run_script` run declares a store blob as an input and its output is put back, the record names the script and that input.

## Let workers write

Dispatched workers read the store. They write only into the tags their dispatch grants, and a granted tag must exist first. The built-in coder, researcher and scout workers use the store without extra setup.

## Limits

- The store lives in PanCode's data directory on one host; `pancode store where` prints its folder. A worker on an SSH fleet node sees that node's own store.
- `put` copies bytes, and the store keeps no earlier versions of a blob.
- `pancode reset --data`, `reset --all` and `uninstall` without `--keep-data` delete the store for good.
- The store has been exercised on Linux only.
