## What PanSDK holds

PanSDK is the contract for writing PanCode extensions, packs, tools and MCP servers. It ships inside the `@akougkas/pancode` npm package, licensed Apache-2.0, as five imports:

| Import | Holds |
| --- | --- |
| `pancode/sdk/extension` | The types an extension runtime is written against. |
| `pancode/sdk/pack` | The validators and limits PanCode applies to a pack's manifest and to what its runtime returns. |
| `pancode/sdk/testing` | A test host that runs a runtime in process, under the same rules. |
| `pancode/sdk/tool` | `defineTool`, `defineServer` and `policyManifest`, for MCP tools with a declared policy. |
| `pancode/sdk/mcp-server` | `serveStdio`, which serves a defined server over MCP stdio. |

The [PanKit](/docs/guide/pankit.html) servers are built on the last two.

## Start an extension

A scaffolded extension needs no `npm install`: its tsconfig points at the installed PanCode.

```sh
pancode extensions init lab-hello
pancode extensions validate .pancode/dev/extensions/lab-hello
pancode extensions test .pancode/dev/extensions/lab-hello
```

`init` writes a package from a template (`status`, `hook`, `panel`, `tool` or `workspace`). `validate` prints `Valid` or `Invalid` with each diagnostic and the capability envelope you will approve, and checks that the runtime registers exactly what its manifest declares. `test` runs the package's tests. See [extensions](/docs/guide/harness-extensions.html) for the runtime API.

## Write a tool server

Any other Node project adds the package as a dependency with `npm install --save-dev pancode@npm:@akougkas/pancode` (Node 22.19 or later) and imports the subpaths:

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

await serveStdio(defineServer({ id: "notes", version: "1.0.0", tools: [echo] }));
```

`actionClass` is `read`, `execute` or `destructive`; a tool that writes files names its write paths in `pathArguments`. A wrong definition throws when the server starts. Log through `context.log`, because stdout carries only protocol frames.

To use the server from PanCode, declare it in `<config>/mcp.yaml` with its classes, since PanCode does not take them from the server, then review it with `pancode mcp trust notes --surface`.

## Limits

- A scaffolded package resolves only `pancode/sdk/extension` and `pancode/sdk/testing` without `node_modules`.
- The scaffold's tsconfig names the installed PanCode by its absolute path, so moving PanCode leaves it pointing at the old place.
- `pancode/sdk/mcp-server` serves tools only, over stdio only, and refuses an inbound line over 4 MiB.
- A server's declared classes are a hint; PanCode applies the classes its operator declares or the policy it ships.
