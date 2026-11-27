# Text Stats Server Template

This template demonstrates a valid **server** pack for PanCode: one MCP server that PanCode declares after
installation and another agent host runs through `pankit serve`.

## Package Structure

```text
text-stats/
  README.md       # Documentation
  plugin.json     # Portable manifest declaring kind: server
  mcp.json        # Exactly one stdio server, named like the pack
  server.mjs      # The server: newline-delimited JSON-RPC on stdin and stdout, no dependencies
```

## Rules

- `mcp.json` declares exactly one server, its id is the pack name, and its transport is `stdio`.
- The pack name is not the id of a server PanCode ships (`node`, `modules`, `darshan`, `spack`, `scidata`,
  `catalog`, `store`).
- The pack has no resource roots and no components.
- `command` is a name found on `PATH` or an absolute path; arguments that name files are relative to the pack, which
  is the server's working directory.

## Validation and Use

```bash
pancode hub validate .
pancode hub register .
pancode hub install server:text-stats
pancode mcp trust text-stats
pancode mcp test text-stats
```
