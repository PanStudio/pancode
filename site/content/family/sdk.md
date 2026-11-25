PanSDK is the typed surface for writing PanCode extensions, packs, tools and MCP servers. It is licensed Apache-2.0, bundled into the `pancode` npm package and imported from five subpaths. PanKit's servers are built on it.

| Import | Holds |
| --- | --- |
| `pancode/sdk/extension` | The types an extension runtime is written against. |
| `pancode/sdk/pack` | The validators and limits PanCode applies to a package's manifest and its runtime's output. |
| `pancode/sdk/testing` | A test host that runs an extension runtime in process, under the same rules. |
| `pancode/sdk/tool` | `defineTool`, `defineServer` and `policyManifest`, for MCP tools with a declared policy. |
| `pancode/sdk/mcp-server` | `serveStdio`, which serves a defined server over MCP stdio. |

## Install

An extension made with `pancode extensions init` needs no install: its tsconfig points at the installed PanCode. Any other Node project adds the package as a dependency. Node 22.19 or later is required.

```bash
npm install pancode
```

## Example

An extension runtime exports a function that receives the API and registers its handlers:

```ts
import type { ExtensionApiV2 } from "pancode/sdk/extension";

export default function activate(api: ExtensionApiV2): void {
	api.handle("hello", () => ({ text: "hello" }));
}
```

`pancode extensions init` scaffolds a package around it, `pancode extensions validate` checks the manifest and `pancode extensions test` runs its tests against the test host.

## Limits

::: limits What PanSDK does not do
- A scaffolded package resolves only `pancode/sdk/extension` and `pancode/sdk/testing` without `node_modules`.
- `pancode/sdk/mcp-server` serves tools only, over stdio only: no resources, prompts or sampling.
- A server's declared classes are a hint to any host; PanCode applies the classes its operator declares.
- The full list is in [the guide's limits](/docs/guide/sdk.html#limits).
:::

## Learn more

::: next Learn more
- [Write extensions and tools with PanSDK](/docs/guide/sdk.html)
- [Write an extension with declared capabilities, a tutorial](/tutorials/write-an-extension-with-declared-capabilities.html)
- [The PanSDK package and its source](../../../packages/sdk/README.md)
- [pancode on npm](https://www.npmjs.com/package/pancode)
:::
