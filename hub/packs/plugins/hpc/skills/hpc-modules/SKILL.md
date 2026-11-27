---
name: hpc-modules
description: "Finds software on an HPC system through the hpc plugin's MCP server (Lmod or Environment Modules, and Spack installs), plans the module loads a script needs, and loads them from bash in the shell that uses them. Not for installing software or for writing the job script's science."
triggers:
  - load the modules this build needs
  - which module provides this software
  - lmod module avail
  - spack find
---

# Software environments: modules and Spack

Find which compiler, MPI and library builds a cluster offers, and make a
command or job use them, so that the run names its exact environment. All of it
is local: no network is needed, and air-gapped login nodes work the same way.

Discovery goes through the `hpc` server this plugin ships. Call a
tool by its capability name, such as `mcp_hpc__modules_avail`; when it is
not attached to the session, call it through
`gateway(op="call", capability="mcp_hpc__modules_avail", args={...})`. A
tool that cannot work on this host answers every call with the
reason. On that answer, or when the tool does not exist (a harness without
this server), use the `bash` steps in "Fallback without the server".

## The one rule: a load lives only in its own shell

`module` is a shell function, not a program. It runs the module tool
(`$LMOD_CMD` for Lmod, `$MODULES_CMD` or `modulecmd` for Environment Modules),
which prints shell code, and `eval`s that code in the current shell. So a
`module load` changes only the shell it runs in. Each `bash` tool call is a
fresh shell, and a load in one call is gone in the next. A program that runs
`module load` as a child process changes nothing, whatever it reports, and the
`hpc` server never evaluates shell code: it finds and plans, and loading
stays in `bash`.

- Put the loads and the command that needs them in one call:
  `bash -lc 'module load gcc/12.2.0 openmpi/4.1.5 && mpicc --version'`.
- In a batch script, put `module purge` and the exact `module load` lines in
  the script itself, before the first command that needs them.
- Write full `name/version` names. A bare `module load gcc` takes the site
  default, which can change under you.

## Phase 1: discover modules

| Question | Tool |
| --- | --- |
| What can I load now? | `mcp_hpc__modules_avail`, `name` to narrow (`match`: `prefix` or `contains`) |
| Every version of a package, loadable or not (Lmod only) | `mcp_hpc__modules_spider` with `name` |
| What must I load first to reach one version? (Lmod only) | `mcp_hpc__modules_spider` with `name` = `<name>/<version>` |
| What does a module set? | `mcp_hpc__modules_show` with `name` |
| What was loaded when PanCode started? | `mcp_hpc__modules_list` |
| Which saved collections exist, and what is in one? | `mcp_hpc__modules_collections`, `name` for one |

`modules_list` reports the environment PanCode started from, not a shell a
later `bash` call built. Sites often build a hierarchy: an MPI or library
module appears in `avail` only after its compiler is loaded. `spider` searches
the whole tree; for `<name>/<version>` it returns the prerequisite sets. Choose
one set, and load it before the module.

## Phase 2: plan, load and record

`mcp_hpc__modules_plan` with `modules` (in load order) returns the ordered
`module load` lines a script needs, prerequisites included. It loads nothing.
Run those lines in one shell, check the result there, and record what you got:

```bash
bash -lc 'module purge && module load gcc/12.2.0 openmpi/4.1.5 && module -t list 2>&1 && which mpicc'
```

Report the exact `module -t list` output with the result. That list is the
environment another person needs to reproduce the run.

## Phase 3: Spack-installed packages

The `spack_*` tools read the Spack instance on `PATH` or in `SPACK_ROOT`.

| Question | Tool |
| --- | --- |
| Which installs match a spec? | `mcp_hpc__spack_find` with `spec` (and `environment` for one environment) |
| A package's versions, variants and dependencies | `mcp_hpc__spack_info` with `package` |
| One install's prefix | `mcp_hpc__spack_locate` with `spec` = `/<hash>` |
| The active and named environments and their roots | `mcp_hpc__spack_env` |
| How a spec would concretize, and what is already installed | `mcp_hpc__spack_spec` with `spec` |

No match from `spack_find` is an answer, not an error. Pass a hash to
`spack_locate`, so the answer is a single install. `spack_spec` is `execute`
and asks first: a first concretization can bootstrap Spack's solver into
Spack's user directories. A read tool that would clone Spack's package
repository returns the command to run once instead; run it only when the user
agrees.

To use an install, `eval` its shell code in the same shell as the command that
needs it: `bash -lc 'eval "$(spack load --sh /<hash>)" && <command>'`.

`spack install` builds software. It needs network access or a configured
mirror, and it takes a long time. Run it only when the user asks for it, and
never as a side step of a lookup.

## Fallback without the server

Run each as `bash -lc '<command>'`; the `-l` login shell reads the site's
profile, which defines `module`.

- Which module system: `type module; echo "LMOD_CMD=$LMOD_CMD MODULES_CMD=$MODULES_CMD"; echo "$MODULEPATH"`.
  `LMOD_CMD` set means Lmod. Neither `module` nor a module tool means there is
  no module system: say so and look for Spack.
- Lmod writes listings to stderr; `--redirect` sends them to stdout and `-t`
  prints one module per line: `module -t --redirect avail`,
  `module -t --redirect spider <name>`, `module --redirect spider <name>/<version>`,
  `module --redirect show <name>/<version>`, `module -t --redirect list`.
  Environment Modules takes `module -t avail`, `module show` and `module -t list`
  with the listing on stderr (`2>&1`), and has no `spider`.
- Spack, after `. <spack root>/share/spack/setup-env.sh`: `spack find -lv <spec>`,
  `spack info <package>`, `spack location -i /<hash>`, `spack env list`.

## Final answer

Name each module or Spack spec with its full version or hash, the prerequisites
you loaded, and the exact command line that ran with them.
