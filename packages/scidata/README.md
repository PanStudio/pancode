# @pancode/scidata

The scientific data package behind PanCode's data tools.
It is part of PanCode, systems software for coding agents.
This workspace package, `@pancode/scidata`, is private: PanCode bundles it at build time and never publishes it on
its own, so the import below works inside this checkout.

It reads HDF5 and NetCDF-4, classic NetCDF, Parquet, Zarr, ADIOS2 BP4/BP5 metadata, CSV/TSV, JSON and JSON Lines.
Every read streams under a bound, reports whether its view is exact or sampled, and refuses with a typed reason
instead of guessing.

```js
import { createScidata, isDataRefusal } from "@pancode/scidata";

const scidata = createScidata({ cacheDir: "/path/to/cache/data-readers" });
const result = await scidata.inspectData("run.h5");
if (isDataRefusal(result)) console.error(result.reason, result.message);
```

`createScidata` takes:

- `cacheDir` (required): where the HDF5 and Parquet readers are kept. They are not dependencies of this package:
  h5wasm and hyparquet are fetched on first use as their exact npm registry tarballs, accepted only when their
  sha256 matches the pin in `SCIENTIFIC_READERS`, and unpacked under `cacheDir`. On an offline host, copy the
  tarball to the path the `reader-unavailable` refusal names.
- `resolveAsset` (optional): supplies a pinned tarball's bytes. The default, `fetchPinnedAsset`, uses a verified
  cached copy, otherwise downloads once with a timeout, verifies and writes atomically, and after a failure no
  process on the host retries for ten minutes. Whatever the resolver returns is checked against the pin again.
- `sqlite` (optional): a SQLite reader. The package ships none; without one a SQLite request is refused as
  `reader-unavailable`.
- `workerUrl` (optional): the reader worker module. The default is this package's built `@pancode/scidata/worker`.

HDF5, NetCDF, Parquet, Zarr and ADIOS2 reads run in a worker thread with a hard timeout. An aborted `signal`
returns the `aborted` refusal and terminates the thread, and the worker's stdout and stderr are piped, so a reader
library's diagnostics never reach the host's own streams.

The package has no runtime dependencies.

## Where it runs

PanCode's `data` tool and its built-in `scidata` MCP server both read files through this package. The `data` tool is
described in [Tool usage](https://pancode.dev/docs/guide/tool-usage.html) and the server in
[Built-in MCP servers](https://pancode.dev/docs/guide/pankit.html); both ship in the `@akougkas/pancode` npm package
(`npm install -g @akougkas/pancode`). The source is
[packages/scidata](https://github.com/akougkas/pancode/tree/main/packages/scidata).

## Limits

- No SQLite reader ships here; PanCode's `data` tool supplies its own, and the built-in `scidata` server has none.
- Each host passes its own `cacheDir`, so PanCode's `data` tool and the built-in `scidata` server keep separate reader caches and
  each downloads the HDF5 and Parquet readers once.
