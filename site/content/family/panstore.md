PanStore keeps a project's datasets and results as blobs in named tags outside the working tree. Each put appends a record of who stored the file, from which run and with which SHA-256, so a result can be traced and checked later. Every checkout and task worktree of one repository reaches the same store.

## Install

PanStore ships with PanCode. Installing PanCode, with the installer or from npm, also installs the `panstore` command.

```bash
curl -fsSL https://pancode.dev/install.sh | sh
npm install -g @akougkas/pancode   # or, with Node.js 22.19 or newer
```

Inside a PanCode project, the same commands run as `pancode store <command>` with the roots and cache from your settings. The model reaches the store through its `store` tool, and any MCP host reaches it through the [PanKit](/pankit.html) `store` server.

## Example

Store a result under a tag with a note, then show its record and check that its bytes still match:

```bash
pancode store put results run-042.csv --note "baseline, 4 nodes"
pancode store stat results:run-042.csv
pancode store verify results
```

`stat` shows the blob's drift (`none`, `changed`, `missing` or `unrecorded`), its SHA-256, the run that produced it and who put it. Outside a PanCode project, `panstore --root <dir> <command>` runs the same commands without the harness. Every command takes `--json`.

## Limits

::: limits What PanStore does not do
- PanStore is exercised on Linux only until its conformance suite runs on macOS and Windows.
- It keeps no blob versions, does no deduplication and has no remote backend. A put replaces the blob's bytes; its records remain.
- A lock left by a host that crashed is never broken automatically: an operator runs `locks break`.
- The full list is in [the guide's limits](/docs/guide/panstore.html#limits).
:::

## Learn more

::: next Learn more
- [Keep results in PanStore](/docs/guide/panstore.html)
- [Keep results in the project store, a tutorial](/tutorials/keep-results-in-the-project-store.html)
- [The PanStore package and its source](../../../packages/store/README.md)
- [@akougkas/pancode on npm](https://www.npmjs.com/package/@akougkas/pancode)
:::
