# The PanCode family

This page describes the products that make up PanCode, where each one's boundary lies, and how they fit together.

The workspace packages live under `packages/`; PanCode reaches them through `openStoreBackend` in [store/index.ts](../../src/domains/store/index.ts), the builtin MCP scope in [builtin.ts](../../src/domains/gateway/mcp/builtin.ts), the hub engine in [hub.ts](../../src/domains/resources/hub.ts) and the extension host in [sdk-compat.ts](../../src/domains/extensions/sdk-compat.ts).

## The products

| Product | Purpose | Boundary | Package and command | Licence |
| --- | --- | --- | --- | --- |
| PanCode | The coding-agent harness: terminal, headless, ACP and desktop surfaces. | Owns the model loop, safety, sessions, dispatch, telemetry, memory and every operator surface. Owns no storage engine, no authoring contract and no tool server. | `pancode` (root `src/`); command `pancode` | PanCode License 1.0 |
| PanStore | The project store: tags and blobs outside the working tree, with records of who put what, from where, with which hash. | Owns names, layout, locks, records, roots, placement, the backend contract and the index. Knows nothing of settings, sessions or PanCode's directories; the host passes them in. | `@pancode/store`; command `panstore` | PanCode License 1.0 |
| PanKit | MCP servers for HPC and scientific work: node facts, environment modules, Spack, Darshan traces, scientific files, dataset catalogs and the project store. | Each server wraps a site's own command-line tools or reads files. It installs nothing and needs no Python. Policy is the host's. | `@pancode/kit`; command `pankit` | PanCode License 1.0 |
| PanHub | Where packs are listed, reviewed, pinned and installed from. | An index (`hub/index.yaml`), a review process and the first-party packs under `hub/packs/`. It runs no service: installation, receipts and workspace trust stay in PanCode's engines. | `hub/` in this repository; command `pancode hub` | Per pack |
| PanSDK | The authoring contract for extensions, packs, tools and MCP servers, usable with no harness installed. | Wire types, manifest validators, limits, the tool definition format, a small stdio MCP server and a test host with injected services. Discovery, the sandbox and process supervision stay in PanCode. | `@pancode/sdk`; imported as `pancode/sdk/<subpath>` | Apache-2.0 |

`@pancode/scidata` is a package, not a product: the scientific file readers (HDF5, NetCDF, Parquet, Zarr, ADIOS2 metadata, CSV, JSON) with their worker thread, timeout and pinned reader downloads. PanCode's `data` tool and PanKit's `scidata` server both use it. Its licence is the PanCode License 1.0.

The licences are each package's `license` field: `Apache-2.0` for `@pancode/sdk`, and `SEE LICENSE IN LICENSE` (the PanCode License 1.0 in the repository's `LICENSE`) for the others. A PanHub pack carries its own licence in its row.

## What depends on what

- `@pancode/kit` imports `@pancode/sdk` (tool and server definitions), `@pancode/store` (the `store` server) and `@pancode/scidata` (the `scidata` server).
- `pancode` imports `@pancode/sdk`, `@pancode/store` and `@pancode/scidata`, and runs `@pancode/kit` as a separate process for each builtin server.
- `@pancode/sdk`, `@pancode/store` and `@pancode/scidata` depend on none of the others.

## How they ship

The four workspace packages are private: none is published to npm on its own. One npm package, `@akougkas/pancode`, carries them all, built from source into its `dist/`:

- the commands `pancode`, `panstore` and `pankit`;
- the SDK subpaths `pancode/sdk/extension`, `pancode/sdk/pack`, `pancode/sdk/testing`, `pancode/sdk/tool` and `pancode/sdk/mcp-server`, with their declarations under `dist/sdk/`;
- PanKit's policy manifest `packages/kit/servers.json`, and the first-party packs under `hub/`.

So the installer, or `npm install -g @akougkas/pancode`, installs every product at one version, and a host that wants only PanKit runs `npx -y -p @akougkas/pancode pankit serve <id>`. Each package's README under `packages/` is its page in the repository; the guides are [PanStore](../guide/panstore.md), [PanKit](../guide/pankit.md), [PanHub](../guide/panhub.md) and [PanSDK](../guide/sdk.md).

## How they plug into PanCode

- **The store adapter.** [store-paths.ts](../../src/core/store-paths.ts) turns settings (`store.roots`, `store.placement`) and PanCode's directories into the options `@pancode/store` takes; [store/index.ts](../../src/domains/store/index.ts) opens the backend, and the `store` tool, `pancode store` and MCP store references all use it.
- **The `builtin` MCP scope.** [builtin.ts](../../src/domains/gateway/mcp/builtin.ts) declares each PanKit server from `packages/kit/servers.json`, runs it from `dist/kit/cli.js`, and passes it this session's store, cache and catalog file. The manifest's tool classes and path arguments are the policy; nothing the server reports overrides them.
- **The hub engines.** [hub.ts](../../src/domains/resources/hub.ts) and its neighbours read the bundled index, hold the verifier for a signed remote index (0.9.0 ships no root key, so none verifies), apply revocations, and hand installs to the plugin and extension engines, which keep digests, workspace trust and `hub-receipts.json`. Detail in [PanHub architecture](panhub.md).
- **The SDK contract.** `src/domains/extensions/` imports the contract from `@pancode/sdk`, and [sdk-compat.ts](../../src/domains/extensions/sdk-compat.ts) fails the typecheck when PanCode's own types and the SDK's wire types drift apart in either direction. `pancode extensions init` scaffolds a project against the installed `dist/sdk/`.
