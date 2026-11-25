# Packs from PanHub

Find, install and manage skills, plugins, extensions and other packs.

## Find a useful skill

PanHub holds installable packs, each of one kind: **skill, agent, prompt, playbook, plugin, or extension**. Open `/hub` or press **Alt+L**. Switch categories with left/right, search with `/`, and open a pack with Enter.

`pancode hub update --all` updates eligible copies, `pancode hub package <directory>` turns a skill directory into a pack, and `pancode hub validate` checks what you author.

Use **Browse** to find available content and **Installed** to manage your copies. Choose **User** for tools shared across projects or **Project** for resources specific to this workspace.

`install` uses user scope unless you pass `--project`; `s` switches scope in PanHub. Project packs live under `.pancode/plugins/`.

For example, preview and install the test-driven-development skill:

```sh
pancode hub install skill:tdd --project --dry-run
pancode hub install skill:tdd --project
```

Then activate it in the terminal:

```text
/skill tdd Add coverage for this parser before changing its behavior.
```

## Write your own prompts and skills

A file such as `.pancode/prompts/bugfix.md` runs as `/bugfix`. A `SKILL.md` with a `description` in `.pancode/skills/<name>/` loads with `/skill <name>`. Prompts and skills that Claude Code, Codex or OpenCode keep in your home folder are found without copying; copies inside a project wait until you trust them.

Move your prompts, skills and settings to another machine with a share archive:

```sh
pancode share export --out project.pancode-share.json --project
pancode share import project.pancode-share.json --dry-run
```

## Command reference

| Command | What it does |
| --- | --- |
| `hub search [query] [--kind <kind>]` | Find packs in the index |
| `hub list` | Show packs in both scopes |
| `hub install <ref> [--dry-run]` | Review and install a pack |
| `hub update <ref>\|--all` | Bring installed copies forward |
| `hub enable`, `disable`, `remove <ref>` | Change one installed copy |

Prefix each with `pancode`. A reference is `kind:name`, such as `skill:tdd`, or an unambiguous bare name. `update --all` skips extensions, which each need their own review.

## Review before installing

The install review shows the destination, dependencies, and verified pack pin. In PanHub, the selected row offers install, update, enable/disable, and remove actions when applicable. Management actions name the owning pack and selected scope.

Project packs take precedence over matching user packs. A disabled project copy also suppresses the user copy, so a project can explicitly keep a resource unavailable. A project pack set you have not approved for the workspace is listed but not loaded, and does not override your user copy; see [plugins](/docs/guide/plugins.html).

## Trust project packs

A project copy comes from the repository, so its digest proves integrity, not your consent. Approve project packs per workspace:

```sh
pancode config trust plugins
pancode config trust plugins --hash <sha256>
```

The first is a read-only review; the second approves what you reviewed, and `--revoke` withdraws it. `/reload hub` applies it to a running session. A changed pack identity needs a new review, and an import never approves one.

## Refresh a running session

After changing recipes through another process, run:

```text
/reload hub
```

Disabling a pack prevents subsequent discovery; it does not stop an in-flight tool or erase instructions already read. Disable deletes no files; `hub enable <ref>` restores the pack. Disabling and removal apply without a reload, while installs from another process need `/reload hub`. `/skill off` clears an active skill's armed tool surface without erasing earlier context.

For bundles of related resources, see [plugins](/docs/guide/plugins.html). To review resources from other coding agents, see [interoperability](/docs/guide/interop.html).
