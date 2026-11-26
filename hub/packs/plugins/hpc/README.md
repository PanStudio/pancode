# HPC pack

Skills for running and inspecting work on an HPC cluster from PanCode. The
pack joins the cluster's software environment, its parallel I/O stack and its
I/O profiler into one workflow. It is content only: the pack declares no MCP
server; it uses the `modules`, `spack` and `darshan` servers PanCode ships, and
`pancode doctor` shows whether this host can serve them.

```bash
pancode hub install plugin:hpc --project
```

Run `/reload hub` in a running session after installing.

| Skill | What it does | Servers | Fallback programs |
| --- | --- | --- | --- |
| `hpc-modules` | Finds modules and Spack installs, plans the module loads a script needs, and loads them in the shell that uses them | `modules`, `spack` | `module`, `$LMOD_CMD`, `spack` over `bash` |
| `hpc-parallel-io` | Correctness rules and tuning for parallel HDF5 and MPI-IO, checked by readback and Darshan counters | `darshan` (through `hpc-darshan`) | `h5pcc`, `h5py`, `mpirun`, `lfs` |
| `hpc-darshan` | Summarizes a Darshan log and names the counters behind each I/O finding | `darshan` | `darshan-parser` over `bash` |

A server that cannot work on this host (no module tool, no Spack, no
darshan-util) answers every call with the reason, and the skills then run the
fallback programs over `bash`. Loading a module or a Spack install always runs
in `bash`, because a load lives only in the shell that runs it.

## Other harnesses

In a harness without PanCode's servers, declare
`npx -y -p @akougkas/pancode pancode mcp serve <id>` (`modules`, `spack` or `darshan`) as a
stdio MCP server yourself, and the skills work the same. Without them, the
skills use the fallback programs.

## Offline behavior

The pack makes no network calls of its own. Its skills and the servers drive
tools installed on the cluster. On an air-gapped login node they work with
these conditions:

- `spack install` needs network or a configured mirror. The skills run it only
  when the user asks. Lookups (`spack_find`, `spack_locate`, `spack find`,
  `spack location`) are local; a lookup that would clone Spack's package
  repository says so instead.
- Lmod, Environment Modules, Darshan, parallel HDF5 and MPI-IO are local or
  cluster-network tools, so they need no internet access once the site has
  installed them.
- The servers ship inside PanCode, so nothing needs a first online launch.

## Licenses and terms

The pack itself is under the PanCode License 1.0. It bundles no third-party code or data, and it
queries no external data service, so no data terms of use apply. The tools it
drives keep their own licenses: Lmod (MIT), Environment Modules (GPL-2.0 or
later), Spack (Apache-2.0 or MIT), Darshan (its own copyright notice), and the
site's MPI and HDF5 builds.
