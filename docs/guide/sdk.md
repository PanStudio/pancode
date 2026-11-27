# Extension API (unstable)

The extension API is the contract for authoring PanCode extensions, packs, tools and MCP servers, imported as `pancode/sdk/<entry point>` from the `@panstudio/pancode` npm package.

The extension API is unstable. Its entry points, types, validators and limits can change in any release until PanCode defines it; pin the PanCode version an extension is tested against.

The entry points are [extension/index.ts](../../packages/sdk/src/extension/index.ts), [pack/index.ts](../../packages/sdk/src/pack/index.ts), [testing/index.ts](../../packages/sdk/src/testing/index.ts), [tool/index.ts](../../packages/sdk/src/tool/index.ts) and [mcp-server/index.ts](../../packages/sdk/src/mcp-server/index.ts); `pancode extensions init|validate|test` is `runExtensionsAuthoring` in [extensions-authoring.ts](../../src/cli/extensions-authoring.ts), and the scaffold is `scaffoldExtension` in [scaffold.ts](../../src/domains/extensions/authoring/scaffold.ts).

## Entry points

The extension API lives in the private workspace package `@pancode/sdk`, licensed Apache-2.0. PanCode bundles it at build time into `dist/sdk/` and never publishes it on its own. The `@panstudio/pancode` package exports it as five subpaths, each with JavaScript and type declarations:

| Import | Holds |
| --- | --- |
| `pancode/sdk/extension` | The types an extension runtime is written against. Type-only: PanCode loads the runtime and passes it the API. |
| `pancode/sdk/pack` | The validators and limits PanCode applies to a package's manifest and to what its runtime returns. |
| `pancode/sdk/testing` | A test host that runs a runtime in process, under the same rules. |
| `pancode/sdk/tool` | `defineTool`, `defineServer` and `policyManifest`, for MCP tools with a declared policy. |
| `pancode/sdk/mcp-server` | `serveStdio`, which serves a defined server over MCP stdio with no runtime dependencies. |

The MCP servers in the hub's `hpc` and `science-data` plugins are built on `pancode/sdk/tool` and `pancode/sdk/mcp-server`.

## Using the extension API

An extension package made with `pancode extensions init` needs no `npm install`: its tsconfig maps `pancode/sdk/extension` and `pancode/sdk/testing` to the installed PanCode's `dist/sdk/`, and `pancode extensions test` supplies `pancode/sdk/testing` when the tests run. See [Scaffold, validate and test](#scaffold-validate-and-test).

Any other Node project, such as an MCP server, adds the package as a dependency under the name `pancode`, so the `pancode/sdk/<entry point>` imports resolve from `node_modules`. Node 22.19 or later is required.

```bash
npm install --save-dev pancode@npm:@panstudio/pancode
```

## Extension types

`pancode/sdk/extension` holds the types an extension runtime is written against. The runtime's entrypoint exports a function that receives the API and registers its handlers:

```ts
import type { ExtensionApiV2 } from "pancode/sdk/extension";

export default function activate(api: ExtensionApiV2): void {
	api.handle("hello", () => ({ text: "hello" }));
}
```

The manifest declares what the runtime registers; here a `pancode-extension.json` with `"runtime": { "api": 2, "entrypoint": "runtime/extension.ts", "commands": [{ "name": "hello", "description": "Say hello." }] }`. The API, the outputs and the manifest fields are in [Runtime api 2](harness-extensions.md#runtime-api-2) and [Package manifest](harness-extensions.md#package-manifest).

## Testing

`pancode/sdk/testing` runs a runtime in a test, in process:

```ts
import { createExtensionTestHost } from "pancode/sdk/testing";

const host = await createExtensionTestHost(packageRoot);
const output = await host.command("hello"); // { text: "hello" }
await host.dispose();
```

The test host drives the same registration code the runtime uses, with in-memory state and store and a fake clock. Besides `command` it has `observe`, `hook`, `tool`, `action`, `interview`, `leave`, `tick`, `advance(ms)`, and `state`, `store` and `now`.

- It reads `pancode-extension.json` on its own. A YAML manifest needs PanCode's loader: run the test with `pancode extensions test`, which supplies it, or pass `services.loadManifest` in the third argument.
- Its other services (state, registration, the timeout error, the builtin tool names) have portable defaults and can be replaced the same way.

## Pack validators

`pancode/sdk/pack` holds the validators PanCode runs on a package. `parseExtensionRuntimeV2` checks a manifest's `runtime` block and throws on the first problem; `capabilityEnvelope` gives what the operator consents to, and `envelopeDigest` its SHA-256:

```js
import { capabilityEnvelope, envelopeDigest, parseExtensionRuntimeV2 } from "pancode/sdk/pack";

const runtime = parseExtensionRuntimeV2({
	api: 2,
	entrypoint: "runtime/extension.ts",
	commands: [{ name: "hello", description: "Say hello." }],
});
const envelope = capabilityEnvelope(runtime);
console.log(envelope.commands, envelopeDigest(envelope)); // [ 'hello' ] and a 64-character hex digest
```

`parseExtensionRuntimeV2({ api: 1 })` throws `runtime.api must be 2`: api 2 is the only runtime contract, and the api 1 types and parsers (`ExtensionApi`, `ExtensionOutput`, `parseExtensionRuntime`, `parseExtensionOutput`) are gone from `pancode/sdk`. The entry point also exports the limits (`RUNTIME_V2_LIMITS`, `VIEW_LIMITS`, `SURFACE_LIMITS` and others) and the parsers for what a runtime returns, such as `parseExtensionOutputV2` and `parseExtensionToolResult`. `pancode extensions validate` reports the same envelope and digest; see [Capability envelope](harness-extensions.md#capability-envelope).

## Tool servers

`pancode/sdk/tool` defines MCP tools and `pancode/sdk/mcp-server` serves them over stdio:

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

- `actionClass` is `read`, `execute` or `destructive`. There is no `write` class: a tool that writes files is `execute` or `destructive` and names its write paths in `pathArguments`. `readOnly` defaults to true for a `read` tool and may not be true for another class; `idempotent` and `openWorld` default to false.
- `title` is the name a host shows a person, listed as the tool's `title` and `annotations.title`. `output` is a JSON Schema listed as the tool's `outputSchema`; a tool that declares it must return `{ json }` of the declared top-level type, or the call fails as a tool error. `defineServer` takes `instructions`, which the server returns from `initialize` and `server/discover`.
- `run` returns `{ text }`, `{ json }` or `{ error }`. A returned `error` or a thrown exception reaches the client as a tool result with `isError: true`.
- `defineTool` and `defineServer` throw when a definition is wrong, so a broken server fails as it starts. `actionClass: "write"` throws `actionClass "write" does not exist`.
- Stdout carries only protocol frames. Log through `context.log`, which writes to stderr. While the server owns the process's stdout it also points the global `console` at stderr, but a tool that writes to `process.stdout` directly still corrupts the stream.
- `context.signal` aborts when the client cancels the call; a cancelled call sends no response.
- `context.progress(progress, total?, message?)` sends `notifications/progress` when the request carried a `progressToken`, and otherwise does nothing. A value that does not increase is dropped, and updates are sent at most every 50 ms except the one that reaches `total`.
- `tools/list` carries each tool's declared policy under `_meta["dev.pancode/policy"]`, and `policyManifest(server)` returns the server's tools, classes and path arguments as stable JSON.
- A request whose `_meta` carries `io.modelcontextprotocol/protocolVersion` is served in MCP `2026-07-28` without a handshake: the server answers `server/discover`, `tools/list` and `tools/call`, and each result carries `resultType` and the server's identity in `_meta`. A request naming another version gets error `-32022` with the supported versions in its data. `initialize` serves the earlier revisions `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05` with `ping`, `tools/list` and `tools/call`, and both may be used on one connection. Invalid arguments are a tool result with `isError: true` in both. The server exits when stdin closes.

To use the server from PanCode, declare it in `<config>/mcp.yaml`. PanCode does not take a server's classes from what it reports, so the declaration sets them:

```yaml
version: 1
servers:
  - id: notes
    command: node
    args: [/path/to/notes-server.mjs]
    toolActionClasses: { echo: read, save: execute }
```

Then `pancode mcp list` shows the server, `pancode mcp trust notes --surface` prints its tool surface and the `--hash` that approves it, and `pancode mcp test notes --call echo --args '{"text":"hi"}'` calls a tool. See [Add an MCP server](configuration-reference.md#add-an-mcp-server); a plugin's server sets classes in its `mcp.json`, as in [Per-tool action classes in mcp.json](authoring-plugins.md#per-tool-action-classes-in-mcpjson).

## Scaffold, validate and test

```bash
pancode extensions init <id> [--template status|hook|panel|tool|workspace] [--dir <path>]
pancode extensions validate <path> [--json]
pancode extensions test <path>
```

`init` writes a package from a template, by default `status`, into `.pancode/dev/extensions/<id>` under the current directory or into `--dir`; it refuses a directory that is not empty. Each template has a YAML manifest, a TypeScript entrypoint and a test; `workspace` also has a skin. The package also gets a `package.json` and a tsconfig whose `paths` name the installed PanCode's `dist/sdk/extension.d.ts` and `dist/sdk/testing.d.ts`, so `tsc -p <path>` type-checks it with no `node_modules`.

```text
$ pancode extensions init lab-hello
Created lab-hello (status) at /work/.pancode/dev/extensions/lab-hello
Next: pancode extensions validate /work/.pancode/dev/extensions/lab-hello
Then: pancode extensions test /work/.pancode/dev/extensions/lab-hello
```

`validate` prints `Valid` or `Invalid` with each diagnostic, the capability envelope and its digest, and the result of a registration check that starts the entrypoint in a private copy to confirm it registers exactly what the manifest declares. It exits 0 when the package is valid and 1 when it is not. The scaffold validates with one warning, `extension_license_missing`, until the manifest declares a `license`.

`test` runs the package's `**/*.test.ts` files with `node --test`, in a temporary directory it creates for the run and removes afterwards, and exits with the test run's code. A usage error in any of the three exits 2. The full behaviour of the three commands, and how a folder under `.pancode/dev/extensions/` loads into a running session, is in [Authoring](harness-extensions.md#authoring).

## Limits

- A scaffolded package resolves only `pancode/sdk/extension` and `pancode/sdk/testing` without `node_modules`. A test that imports another entry point, such as `pancode/sdk/pack`, fails with `ERR_MODULE_NOT_FOUND` unless the `pancode` package is installed where Node can find it.
- The scaffold's tsconfig names the installed PanCode by its absolute path, so moving or reinstalling PanCode to another place leaves it pointing at the old one.
- The test host reads only `pancode-extension.json` by itself; a YAML manifest needs `pancode extensions test` or `services.loadManifest`.
- The test host does not provide the work services (`ctx.runs`, `ctx.worktrees`, `ctx.verify`, `ctx.claims`) or `ctx.progress`. Test a command that uses them by installing the package and running it with `pancode extensions run`.
- `pancode/sdk/mcp-server` serves tools only: no resources, prompts or sampling, over stdio only. It refuses an inbound line over 4 MiB, and it does not truncate large results.
- A server's declared classes are a hint to any host; PanCode applies the classes its operator declares or a plugin's `mcp.json` sets in `toolActionClasses`.
