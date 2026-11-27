# Community packs

A community pack enters PanHub as one row file, `hub/community/<publisher>/<name>.yaml`. The publisher is your
lowercase GitHub owner name and the name is the pack id. The file holds one row, or a plugin row and the row for
the extension that serves it:

```yaml
rows:
  - kind: plugin
    publisher: <owner>
    name: <pack id>
    version: <semver>
    description: <text>
    source:
      repo: https://github.com/<owner>/<repo>
      commit: <full 40-character commit>
      subdir: <path to the pack in the repository>
    sha256: <content digest of the pack tree>
    license: <SPDX expression>
    tier: listed
```

`pnpm hub:pin` fetches that exact commit, refuses a tree whose digest differs from `sha256`, and writes the index
row from the tree. Every field the row file states must hold at the commit. Hints such as `provides`, `requires`,
`envelopeDigest` and `mcpDigest` are derived, so you may leave them out.

## Submitting

- Change one row file and nothing else. The hub review job fails a pull request from a fork that touches more.
- Name a commit, never a branch or tag. A new version is a new commit and a new `sha256`.
- State a licence. A row without one fails `pnpm hub:check`.
- Start at `tier: listed`. A listed pack installs with foreign trust: its MCP servers and skills stay held until
  the operator trusts them.

## The `verified` checklist

A maintainer moves a row to `tier: verified` only when all of these hold at the named commit:

- The licence is on the allowlist: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, CC-BY-4.0 or
  CC0-1.0.
- Every `uvx` or `npx` launch in `mcp.json` names an exact version (`pkg==x.y.z`, `--from pkg==x.y.z` or
  `pkg@x.y.z`).
- No skill or prompt body carries instructions aimed at the host: overriding earlier instructions or the system
  prompt, changing settings or trust, or piping a download to a shell.
- The extension envelope, if any, has been read and its reach matches what the pack says it does.
- An MCP server's launch command, which the review prints, runs what the pack says it does.
- The pack builds and its tests pass at the commit.

A listing, at any tier, is not an endorsement. PanCode checks that the bytes you install are the bytes the row
names; it does not vouch for what they do.

## Revocation

A pack tree found to be harmful is revoked by its digest in `hub/revoked.yaml`. PanCode then refuses to offer or
install it, and stops an installed copy.
