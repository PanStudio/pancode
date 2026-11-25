# Pipeline Review Playbook Template

This template demonstrates a valid standalone **playbook** package for PanCode. A playbook is what the fleet runs.

## Package Structure

```text
pipeline-review/
  README.md                     # Documentation (outside resource root)
  plugin.json                   # Portable manifest declaring kind: playbook
  playbooks/
    pipeline-review.md          # Multi-agent coordination playbook
```

> **Important**: Place `README.md` at the package root, never inside the `playbooks/` resource root. Single-kind packages expose exactly one public candidate in their declared resource directory.

## Graph and Step Semantics

- **Version**: 1 to 5. Version 1 runs agent steps only; 2 adds code steps; 3 adds bounded loops and commit steps; 4 requires every step to declare its write boundary; 5 adds gate and plan steps and per-step `target`/`profile` routes.
- **Steps**: Each step specifies `id`, `agent`, `scope`, and `dependencies`.
- **Graph Validity**: Steps must form a directed acyclic graph (DAG) without cycles or unknown dependencies.
- **Prompt Body**: Uses strict `{{var}}` interpolation; all variables must be supplied at invocation (e.g. `--var pipeline=configs/pipeline.yaml`).
- **Prerequisites**: Playbooks that reference core built-in agents (e.g., `scout`, `verifier`) should clearly document these dependencies in their body.

## Validation

```bash
pancode hub validate .
```
