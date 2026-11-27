# HPC pack

Skills for running and inspecting work on an HPC cluster from PanCode. The
pack joins the cluster's software environment, its parallel I/O stack and its
I/O profiler into one workflow. The pack ships one MCP server, `hpc`, with the
node, module, Spack and Darshan tools below. It is the bundled `server.mjs`,
started as `node server.mjs`, with no dependencies to install.

```bash
pancode hub install plugin:hpc --project
```

Run `/reload hub` in a running session after installing.

| Skill | What it does | Tools | Fallback programs |
| --- | --- | --- | --- |
| `hpc-modules` | Finds modules and Spack installs, plans the module loads a script needs, and loads them in the shell that uses them | `modules_*`, `spack_*` | `module`, `$LMOD_CMD`, `spack` over `bash` |
| `hpc-parallel-io` | Correctness rules and tuning for parallel HDF5 and MPI-IO, checked by readback and Darshan counters | `darshan_*` (through `hpc-darshan`) | `h5pcc`, `h5py`, `mpirun`, `lfs` |
| `hpc-darshan` | Summarizes a Darshan log and names the counters behind each I/O finding | `darshan_*` | `darshan-parser` over `bash` |

A tool that cannot work on this host (no module tool, no Spack, no
darshan-util) answers every call with the reason, and the skills then run the
fallback programs over `bash`. Loading a module or a Spack install always runs
in `bash`, because a load lives only in the shell that runs it.

## The `hpc` server

Every tool is `read` except `spack_spec`, which is `execute`. PanCode starts the
server with the module and Spack variables from its own environment
(`MODULEPATH`, `MODULESHOME`, `LOADEDMODULES`, `_LMFILES_`, `LMOD_*`,
`MODULES_*`, `_ModuleTable*`, `__LMOD_*`, `__MODULES_*` and the `SPACK_*`
settings), so start PanCode from a shell where `module avail` works.

| Tool | Class | Path arguments | Returns |
| --- | --- | --- | --- |
| `node_cpu` | `read` | none | CPU model, architecture, socket, core and thread counts, the threads the process may use, and load averages |
| `node_memory` | `read` | none | Physical memory and swap, in bytes |
| `node_disks` | `read` | none | Mounted file systems (at most 100) with size, free and available bytes and inode counts |
| `node_network` | `read` | none | Hostname and network interfaces with their addresses; no hardware addresses |
| `node_gpus` | `read` | none | NVIDIA GPUs through `nvidia-smi`, with memory in bytes and utilization |
| `node_processes` | `read` | none | The top processes by CPU or memory (at most 50), with the command name and never its arguments |
| `modules_list` | `read` | none | The modules loaded when the server started, in load order |
| `modules_avail` | `read` | none | The modules on `MODULEPATH`, with their source directory and whether each is the default |
| `modules_show` | `read` | none | One module's modulefile path, text and declared changes |
| `modules_spider` | `read` | none | Lmod only: matching modules across the whole hierarchy, and what must be loaded first |
| `modules_plan` | `read` | none | The `module load` lines a batch script needs for 1 to 20 modules; it never loads anything |
| `modules_collections` | `read` | none | The user's saved collections, or the modules one collection loads |
| `spack_find` | `read` | none | Installed specs with hash, compilers, prefix and whether each was installed explicitly |
| `spack_info` | `read` | none | One package's versions, variants, dependencies and licenses |
| `spack_locate` | `read` | none | The prefix of an installed spec, or a package's recipe directory |
| `spack_spec` | `execute` | none | How a spec concretizes and which nodes are already installed; a first concretization can bootstrap Spack's solver into Spack's user directories |
| `spack_env` | `read` | none | The active and named environments, with their root specs and install status |
| `darshan_summary` | `read` | `path` read | The job (executable without its arguments, uid, job id, times, process count), mounts, modules, and per-module bytes, seconds, opens and rate |
| `darshan_files` | `read` | `path` read | The top files of one module, ranked by a chosen counter |
| `darshan_modules` | `read` | `path` read | Every counter of one module, summed over files and ranks |
| `darshan_timeline` | `read` | `path` read | Bytes read and written per time bin, from the heatmap or the DXT trace |

## Other harnesses

The pack's `.mcp.json` declares the same server for Claude Code. Any other MCP
host runs it as a stdio server with `node <pack>/server.mjs` (Node.js 22 or
later), and the skills work the same. Without it, the skills use the fallback
programs.

## Offline behavior

The pack makes no network calls of its own. Its skills and the server drive
tools installed on the cluster. On an air-gapped login node they work with
these conditions:

- `spack install` needs network or a configured mirror. The skills run it only
  when the user asks. Lookups (`spack_find`, `spack_locate`, `spack find`,
  `spack location`) are local; a lookup that would clone Spack's package
  repository says so instead.
- Lmod, Environment Modules, Darshan, parallel HDF5 and MPI-IO are local or
  cluster-network tools, so they need no internet access once the site has
  installed them.
- The server ships bundled in the pack, so nothing needs a first online launch.

## Licenses and terms

The pack itself is under the PanCode License 1.0. It bundles no third-party code or data, and it
queries no external data service, so no data terms of use apply. The tools it
drives keep their own licenses: Lmod (MIT), Environment Modules (GPL-2.0 or
later), Spack (Apache-2.0 or MIT), Darshan (its own copyright notice), and the
site's MPI and HDF5 builds.
