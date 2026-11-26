# PanStore

PanStore, the project store, usable as a library without the harness.
It is part of PanCode, systems software for coding agents.
This workspace package, `@pancode/store`, is private: PanCode bundles it at build time and never publishes it on its
own, so the imports below work inside this checkout. Its commands run as `pancode store`, which ships with the
`@akougkas/pancode` npm package.

## Install

```sh
npm install -g @akougkas/pancode
pancode store tags
```

The guide is [PanStore](https://pancode.dev/docs/guide/panstore.html); the source is
[packages/store](https://github.com/akougkas/pancode/tree/main/packages/store).

## Entry points

| Import | What it gives you |
| --- | --- |
| `@pancode/store` | Everything below except `./cli`, plus `createLocalStoreBackend`, `registerStoreBackend`, `resolveStoreBackend`, `withStoreLock`, `recordedPut`, `recordedRemove`, `verifyStoreTag` and the records API (`appendRecord`, `readBlobHistory`, `currentState`, `summarizeRecords`, `driftOf`). |
| `@pancode/store/backend` | The `StoreBackend` interface, its fact and result types, `StoreRefusal`, and `compileBlobPattern`. |
| `@pancode/store/paths` | Tag and blob name validation, tag segment encoding, records-tag helpers, `storeProjectKey`, `storeMainCheckout`, `storeProjectRootOf`, root and placement validation, `resolvePlacement`, and the on-disk layout functions, each taking the store root and project key (or the project directory) as arguments. |
| `@pancode/store/cli` | The command line as a module: `runStoreCli(argv, context)` and one function per verb, for a host that supplies its own roots, actor and provenance. |
| `@pancode/store/testing` | `runStoreBackendConformance(name, make)`, the `node:test` cases every backend must pass. |

## Opening a local store

```ts
import { createLocalStoreBackend, readBlobHistory, storeProjectKey } from "@pancode/store";

const backend = createLocalStoreBackend({
	roots: [{ name: "default", path: "/home/me/.local/share/pancode/data/store", durable: true, purge: null }],
	cacheDir: "/home/me/.cache/pancode",
	projectKey: storeProjectKey("/home/me/src/sim"),
	projectRoot: "/home/me/src/sim",
});
const tags = await backend.listTags();
const history = await readBlobHistory(backend, "sim/run7", "a.txt");
```

`LocalStoreOptions`:

- `roots`: non-empty; project stores live under `<root.path>/projects/<projectKey>`. The first root is the
  primary: it must be durable and holds the records tags, the locks and `placement.json`, which names the root
  each tag was created on. A non-durable root takes only tags of class `cache`.
- `placement` (optional): `{ byTag, byClass }` naming the root a new tag goes to; default the primary. Changing
  the rules never moves a tag that exists.
- `cacheDir`: `getBlobAsPath` copies live under `<cacheDir>/store/<projectKey>`, owner read-only.
- `projectKey`: `storeProjectKey` of the project's main checkout.
- `projectRoot`: the main checkout, written to `project.json` when the store first creates the project.
- `prepareRoot` (optional): runs before `getOrCreateTag` makes its first directory, and only there, so reads
  never create anything. The harness uses it to give a missing data root its mode and marker.
- `serialize` (optional): orders writers of one file within the process; the store lock orders them across
  processes. Default: run the write directly.

The package does not resolve XDG directories or walk to a project root; the host passes the resolved paths in.

## `pancode store`

`pancode store` runs the store's commands from a shell, against the roots, cache and project PanCode resolves from
its settings: `tags`, `ls`, `stat`, `history`, `verify`, `put`, `get`, `rm`, `rm-tag`, `adopt`, `where`, `usage` and
`locks`. Every checkout and task worktree of one repository derives the same project key; a project's
`store.projectId` keys the store by that id instead, so checkouts at different paths on different hosts reach one
store. The records these commands write name the actor `standalone`. `locks` lists the project's store locks and
their state (`live`, `dead`, `remote`, `unreadable`); `locks break <id>` removes one that is not live.
`pancode store where` prints the `pankit serve store` command line that serves a PanCode project's store over MCP.

## Limits

- PanStore is exercised on Linux only until its conformance suite runs on the macOS and Windows runners.
- A root on a network file system reports `sharedFs: unverified` and the backend reports `multiNode: false`; two
  hosts writing one root are not supported.
- No blob versions, no deduplication and no remote backend.

The full list is in [PanStore limits](https://pancode.dev/docs/guide/panstore.html#limits).
