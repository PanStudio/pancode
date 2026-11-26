---
name: find-skills
description: Finds published skills and prepares their PanHub installation for the operator when the user asks whether a capability exists as a skill. Not for authoring a new skill; use skill-authoring.
triggers:
  - find a skill
  - is there a skill for this
  - install a skill
  - add an agent skill
  - search the skills marketplace
version: 0.3.4
license: LicenseRef-PanCode-1.0
allowed-tools:
  - bash
  - web_fetch
  - read
  - ls
  - ask_user
pancode:
  registry-id: PanStudio/pancode
  source-url: https://github.com/PanStudio/pancode/tree/main/hub/packs/skills/meta/find-skills
  audit: pass
  model-size: any
---

# Find Skills

Find reusable skills through PanCode's PanHub. Keep the package's origin,
format, installation scope and actual component availability distinct. PanHub
management is operator authority in PanCode; the agent discovers, inspects
and recommends without trying to write protected active roots.

## Procedure

1. **Search PanHub first.** Run `pancode hub search <query>`, where
   every word has to match, and inspect
   `pancode hub components --kind skill --json` for actual components.
   In a PanCode session, `gateway(op="call", capability="pancode_hub", args={kind: "skill", query: "..."})`
   provides the same discovery facts. A catalog hint describes a package's
   contents; it does not prove a skill is installed or usable. Check copy scope,
   trust, enablement, integrity and resource diagnostics before reporting that
   the capability is available. An installed but disabled package needs a
   different action from a missing package.

2. **Research external candidates when needed.** Browse https://skills.sh and
   GitHub read-only. Record source URL, description and evidence of quality.
   Distinguish a complete portable `plugin.json` package, a supported Claude
   Code or Codex plugin, and a bare `SKILL.md` directory. A GitHub listing alone
   does not prove its payload is directly installable. Do not execute a
   candidate's setup instructions while researching it.

3. **Prepare the exact operator action.** Use a typed reference such as
   `pancode hub install skill:context-handoff --project` for a catalog
   package. Use `hub install <package-path-or-github-tree-url>` for a
   portable package, and `hub import <path-or-github-tree-url> --dry-run`
   to review a supported foreign plugin's projection and omitted features.
   A bare `SKILL.md` directory takes the same import, as a text-only copy, and
   the plan refuses one whose instructions use a script it cannot copy. To keep
   the script, `hub package <path>` writes the manifest and
   `hub install <path>` installs it.
   Do not promise that every skill URL works as an install source.

4. **Use the operator's PanHub controls.** Point to `/hub` or Alt+L for
   review and installation. Show the requested scope explicitly: `--project`
   uses `<cwd>/.pancode/plugins/<package-name>/`; `--user` uses
   `<configDir>/plugins/<package-name>/` and is the CLI default. Every kind
   uses that complete-package store. Loose `.pancode/skills/` files are a
   separate operator-managed discovery surface. Honor authorization already
   provided, while explaining that the PanCode operator must apply the mutation
   through the UI or CLI; do not retry blocked install commands as shell tricks.

5. **Verify after the operator applies it.** Read
   `pancode hub components --kind skill --json` and
   `pancode hub inspect <kind>:<package-name> --json`. Confirm the actual
   runtime name, whole-package owner, selected scope and component availability.
   Report disabled, foreign, shadowed or invalid states plainly; an installed
   directory alone is not success. Use `/skill <runtime-name>` for activation;
   `/hub skills` opens the category browser. Do not invent an audit status. A copy
   its catalog has moved past reads `update <version> available` in
   `hub list`; `hub update --all` brings those forward.

## Host boundaries

For a PanCode installation, keep management in its PanHub. External
installers such as `npx skills add` target another host's roots and do not
update PanCode's package state. If the user explicitly wants a Claude Code or
Codex installation instead, follow that host's documented marketplace or
skill-installation route and name the destination clearly. A PanHub
pack is portable; installing it for one host does not install it for all.
