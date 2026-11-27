# Components and workspace packages

PanCode is one product. This page describes the components inside it, the workspace packages that hold their code, where each boundary lies, and how PanCode reaches them.

PanCode reaches the packages under `packages/` through `openStoreBackend` in [store/index.ts](../../src/domains/store/index.ts), the hub engine in [hub.ts](../../src/domains/resources/hub.ts) and the extension host in [sdk-compat.ts](../../src/domains/extensions/sdk-compat.ts).

## The components

| Component | Purpose | Boundary | Code | Command |
| --- | --- | --- | --- | --- |
| The harness | Panos, the model loop, safety, sessions, dispatch, telemetry, memory and every operator surface: terminal, headless, ACP and desktop. | Owns no storage engine, no extension contract and no tool server; it reaches them through the packages below. | root `src/` | `pancode` |
| PanStore | The project store: tags and blobs outside the working tree, with records of who put what, from where, with which hash. | Owns names, layout, locks, records, roots, placement, the backend contract and the index. Knows nothing of settings, sessions or PanCode's directories; the harness passes them in. | `packages/store` (`@pancode/store`) | `pancode store` |
| PanHub | The marketplace where packs are listed, reviewed, pinned and installed from. | An index (`hub/index.yaml`), a review process and the first-party packs under `hub/packs/`. It runs no service: installation, receipts and workspace trust stay in PanCode's engines. | `hub/` | `pancode hub` |
| The extension API (unstable) | The contract for authoring extensions, packs, tools and MCP servers. | Wire types, manifest validators, limits, the tool definition format, a small stdio MCP server and a test host with injected services. Discovery, the sandbox and process supervision stay in the harness. | `packages/sdk` (`@pancode/sdk`) | imported as `pancode/sdk/<subpath>` |

`packages/scidata` (`@pancode/scidata`) holds the scientific file readers (HDF5, NetCDF, Parquet, Zarr, ADIOS2 metadata, CSV, JSON) with their worker thread, timeout and pinned reader downloads. PanCode's `data` tool uses it.

The licences are each package's `license` field: `Apache-2.0` for `@pancode/sdk`, and `SEE LICENSE IN LICENSE` (the PanCode License 1.0 in the repository's `LICENSE`) for the others. A PanHub pack carries its own licence in its row.

## What depends on what

- The harness imports `@pancode/sdk`, `@pancode/store` and `@pancode/scidata`.
- The MCP servers in the hub's `hpc` and `science-data` plugins are built on `@pancode/sdk` and bundled into each plugin's `server.mjs`.
- `@pancode/sdk`, `@pancode/store` and `@pancode/scidata` depend on none of the others.

## How they ship

The three workspace packages are private: none is published to npm on its own. One npm package, `@panstudio/pancode`, carries them all, built from source into its `dist/`:

- the command `pancode`;
- the extension API subpaths `pancode/sdk/extension`, `pancode/sdk/pack`, `pancode/sdk/testing`, `pancode/sdk/tool` and `pancode/sdk/mcp-server`, with their declarations under `dist/sdk/`;
- the first-party packs under `hub/`.

So the installer, or `npm install -g @panstudio/pancode`, installs every component at one version. The guides are [PanStore](../guide/panstore.md), [PanHub](../guide/panhub.md) and [Extension API (unstable)](../guide/sdk.md).

## How they plug into the harness

- **The store adapter.** [store-paths.ts](../../src/core/store-paths.ts) turns settings (`store.roots`, `store.placement`) and PanCode's directories into the options `@pancode/store` takes; [store/index.ts](../../src/domains/store/index.ts) opens the backend, and the `store` tool, `pancode store` and MCP store references all use it.
- **The hub engines.** [hub.ts](../../src/domains/resources/hub.ts) and its neighbours read the bundled index, hold the verifier for a signed remote index (this build ships no root key, so none verifies), apply revocations, and hand installs to the plugin and extension engines, which keep digests, workspace trust and `hub-receipts.json`. Detail in [PanHub architecture](panhub.md).
- **The extension API contract.** `src/domains/extensions/` imports the contract from `@pancode/sdk`, and [sdk-compat.ts](../../src/domains/extensions/sdk-compat.ts) fails the typecheck when PanCode's own types and the API's wire types drift apart in either direction. `pancode extensions init` scaffolds a project against the installed `dist/sdk/`.
