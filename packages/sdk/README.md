# PanSDK

PanSDK, the contract for authoring PanCode extensions, packs, tools and MCP servers.
It is part of PanCode, systems software for coding agents.
It ships inside the `pancode` npm package as `pancode/sdk/<subpath>`. This workspace package, `@pancode/sdk`, is
private: PanCode bundles it at build time and never publishes it on its own.

## Install

PanSDK comes with the `pancode` npm package, which needs Node 22.19 or later, and its source is licensed
Apache-2.0.

```bash
npm install pancode   # in a project that imports pancode/sdk/*
```

An extension package scaffolded with `pancode extensions init` needs no install: it resolves
`pancode/sdk/extension` and `pancode/sdk/testing` against the installed PanCode's `dist/sdk/`.

## Entry points

| Import | Holds |
| --- | --- |
| `pancode/sdk/extension` | The types an extension runtime is written against (type-only). |
| `pancode/sdk/pack` | The validators and limits PanCode applies to a package's manifest and to what its runtime returns. |
| `pancode/sdk/testing` | A test host that runs a runtime in process, under the same rules. |
| `pancode/sdk/tool` | `defineTool`, `defineServer` and `policyManifest`, for MCP tools with a declared policy. |
| `pancode/sdk/mcp-server` | `serveStdio`, which serves a defined server over MCP stdio with no runtime dependencies. |

## Extensions

`pancode/sdk/extension` holds the types an extension runtime is written against. It is type-only: PanCode loads the
runtime and passes it the API. `pancode/sdk/pack` holds the validators and limits PanCode applies to a package's
manifest and to what its runtime returns. `pancode/sdk/testing` runs a runtime in a test, in process, under those
same rules.

```ts
import type { ExtensionApiV2 } from "pancode/sdk/extension";

export default function activate(api: ExtensionApiV2): void {
	api.handle("hello", () => ({ text: "hello" }));
}
```

```ts
import { createExtensionTestHost } from "pancode/sdk/testing";

const host = await createExtensionTestHost(packageRoot);
const output = await host.command("hello");
await host.dispose();
```

- The test host reads `pancode-extension.json` on its own. A YAML manifest needs PanCode's loader: run the test with
  `pancode extensions test`, which supplies it, or pass `services.loadManifest`.
- Its other services (state, registration, the timeout error, the builtin tool names) have portable defaults and
  can be replaced the same way through the third argument.

```bash
pancode extensions init <id> [--template status|hook|panel|tool|workspace] [--dir <path>]
pancode extensions validate <path> [--json]
pancode extensions test <path>
```

`init` scaffolds a package whose tsconfig resolves the SDK imports against the installed PanCode, so it type-checks
and tests without a `node_modules`. `validate` prints the capability envelope and its digest, and `test` runs the
package's `**/*.test.ts` files.

## Tool servers

`pancode/sdk/tool` defines MCP tools and `pancode/sdk/mcp-server` serves them over stdio, with no runtime
dependencies.

```js
import { serveStdio } from "pancode/sdk/mcp-server";
import { defineServer, defineTool } from "pancode/sdk/tool";

const echo = defineTool({
	name: "echo",
	description: "Echo the text back.",
	input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	actionClass: "read",
	run: (args) => ({ text: args.text }),
});

const save = defineTool({
	name: "save",
	description: "Write text to a file.",
	input: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } }, required: ["path"] },
	actionClass: "execute",
	pathArguments: { path: "write" },
	run: async (args, { signal, log }) => {
		log(`saving ${args.path}`);
		// ... write the file, honoring signal ...
		return { json: { saved: args.path } };
	},
});

await serveStdio(defineServer({ id: "notes", version: "1.0.0", tools: [echo, save] }));
```

- `actionClass` is `read`, `execute` or `destructive`. There is no `write` class: a tool that writes files is
  `execute` or `destructive` and names its write paths in `pathArguments`. `readOnly` defaults to true for a `read`
  tool and may not be true for another class; `idempotent` defaults to false.
- `run` returns `{ text }`, `{ json }` or `{ error }`. A returned `error` or a thrown exception reaches the client as
  a tool result with `isError: true`. The SDK does not truncate large results.
- `defineTool` and `defineServer` throw when a definition is wrong, so a broken server fails as it starts.
- Stdout carries only protocol frames. Log through `context.log`, which writes to stderr. While the server owns the
  process's stdout it also points the global `console` at stderr, but a tool that writes to `process.stdout`
  directly still corrupts the stream.
- `context.signal` aborts when the client cancels the call; a cancelled call sends no response.
- `policyManifest(server)` returns the server's tools, classes and path arguments as stable JSON.

What a server says about itself is a hint to any host. PanCode decides a tool's class from the operator's approval or
from policy it ships, never from what a running server reports. PanKit's servers are built this way.

## Limits

A scaffolded package resolves only `pancode/sdk/extension` and `pancode/sdk/testing` without `node_modules`, and
`pancode/sdk/mcp-server` serves tools only, over stdio. The full list is in
[the guide's Limits](https://pancode.dev/docs/guide/sdk.html#limits).

## Documentation

- PanSDK guide, with every entry point and the authoring commands: https://pancode.dev/docs/guide/sdk.html
- Extensions and runtime api 2: https://pancode.dev/docs/guide/harness-extensions.html
- PanKit, built on this SDK: https://pancode.dev/docs/guide/pankit.html
- Source: https://github.com/akougkas/pancode/tree/main/packages/sdk
- PanCode: https://github.com/akougkas/pancode
