PanHub contains skills, agents, prompts, playbooks, and plugins. You can add a procedure to one project or install it for your user. Preview what will be written, inspect the resource, and load it when a task needs it.

::: note Version scope
PanHub recipes and extensions have different roles, and installing either is not a grant of authority.
:::

::: diagram hub-flow
:::

## Browse what ships with PanCode

Open `/hub` in the terminal or press Alt+L. On the desktop alpha, the PanHub page lists the catalog with an **Installed only** filter. In the terminal, **Browse** shows available content and **Installed** manages your copies.

PanHub in the terminal is one place. `/hub skills` opens it on one kind, as do `prompts`, `agents`, `playbooks`, `plugins` and `extensions`. `/hub install <ref>` and the other verbs of `pancode hub` open the review that command would apply. `/hub interop` inspects the coding agents on your machine.

Inside PanHub, `b` switches between Browse and Installed and `s` between user and project scope. `i`, `u` and `x` open the review for installing, updating or removing the selected package; nothing is written until you apply it. `r` refreshes.

::: capture tui-hub-skill-tdd
:::

## Preview a small addition

::: steps
### Preview the install

Start with a resource you can evaluate, such as the shipped test-driven-development skill:

```sh
pancode hub install skill:tdd --project --dry-run
```

The plain output names the planned step and its scope. Add `--json` to see the rest of the plan: the destination, the version it writes, the source with its sha256, and the dependencies.

::: capture cli-hub-dry-run
:::

### Install it for this project

```sh
pancode hub install skill:tdd --project
```

The first project install in a workspace is yours, so PanCode approves the project's packages for that workspace. After that, a changed project package set, including one that arrives with a clone or a pull, is listed but not loaded until you review it with `pancode config trust plugins` and approve the digest it prints.

### Load it for one concrete task

```text
/skill tdd Add coverage for this parser before changing its behavior.
```
:::

::: capture tui-hub-installed
:::

::: result What installing establishes
The skill is available and pinned. Installing it does not establish that it writes the right tests; review its instructions, the resulting changes, and the recorded checks. The [PanHub guide](/docs/guide/panhub.html) covers the current controls.
:::

## Choose project or user scope

Project packages take precedence over matching user packages, and a disabled project copy also suppresses the user copy. A project can therefore keep a resource unavailable instead of inheriting it from one developer's setup.

::: compare
| Scope | Who it serves | What takes precedence |
| --- | --- | --- |
| Project | Everyone working in this repository | A matching project package, even when disabled |
| User | You, across projects | Used when the project has no matching package |
:::

Scope helps reproducibility: another person can see which procedures belong to the project. It is not a filesystem sandbox, and the project's normal execution and tool controls still apply.

## Use plugins for related resources

A PanHub plugin groups related skills, prompts, agents, playbooks, and supporting files. The catalog ships with PanCode, but its content is not installed automatically.

```sh
pancode hub list --kind plugin
pancode hub install plugin:hpc --dry-run
```

::: capture cli-hub-list-plugin
:::

Review the bundle before installing it, and add `--project` when it should belong to the workspace. Local bundles use the same review flow; the [plugin guide](/docs/guide/plugins.html) covers structure and lifecycle.

Installation records a pin over the complete package tree, and drifted content is blocked from loading. Verifying a pin is not a way to approve arbitrary edits to an installed package; use the documented update and review workflow.

## Keep discovery separate from loading

A large PanHub collection should not mean every resource enters every model request. The coordinator starts with a smaller attached toolkit and discovers secondary capabilities when a task calls for them, and recipes load on demand.

Write clear resource descriptions and narrow procedures. A skill that explains one project's numerical-test conventions is easier to select and inspect than a bundle that promises to solve every task.

After changes made by another process, `/reload hub` refreshes recipes and `/skill off` clears an active skill's armed tool surface. Neither erases earlier instructions from the conversation, and disabling a resource does not stop a tool already running.

## Know when you need an extension

PanHub plugins provide portable recipes. [Extensions](/tutorials/write-an-extension-with-declared-capabilities.html) are code that adds runtime tools, hooks, or interface behavior through `pancode extensions`, and load only after you approve the capabilities they declare.

Adding tool schemas requires a new session; reloading recipes does not change them. Project extensions follow the same trust rule through `pancode config trust extensions`, and PanCode names any it ignored when a session starts.

::: limits
- Choose the least extensive mechanism that supplies the task.
- Workspace trust decides whether project packages load. It does not review them for you.
- Review executable code before using it, and account for its commands and network access under your own machine's permissions.
- A bigger collection helps only when it serves a better-defined task.
:::

::: next
- [Your first session with PanCode](/tutorials/first-session.html)
- [PanHub guide](/docs/guide/panhub.html)
- [Plugin guide](/docs/guide/plugins.html)
:::
