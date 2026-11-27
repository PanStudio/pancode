---
name: hpc-darshan
description: "Characterizes an application's I/O from a Darshan log through the hpc plugin's MCP server (darshan-parser as the fallback): reads volumes, access sizes, sequentiality and collective use, and names the bottleneck the counters support. Not for instrumenting a build or for tuning without a log."
triggers:
  - analyze a darshan log
  - darshan counters for this run
  - i/o bottleneck from a darshan log
  - characterize the application's i/o
---

# Darshan I/O analysis

A Darshan log records what one run did to the file system: bytes, operation
counts, request-size histograms and time per module (POSIX, MPI-IO, STDIO). Read
it before tuning I/O, and read it again after, so that every claim about I/O
names the counter behind it. The analysis is local and read-only: it needs
`darshan-util` on `PATH` and no network.

The reads go through the `hpc` server this plugin ships. Call a tool by its
capability name, such as `mcp_hpc__darshan_summary`; when it is not
attached to the session, call it through
`gateway(op="call", capability="mcp_hpc__darshan_summary", args={...})`. A
tool that cannot work on this host answers every call with the
reason (for example, `darshan-parser` is not on `PATH`). On that answer, or
when the tool does not exist (a harness without this server), use the
`bash` steps in "Fallback without the server".

## Phase 0: find the log

1. The log is a `*.darshan` file. Runtime builds write it to the site's log
   directory, organized by date, and `DARSHAN_LOGFILE` names an exact path for
   one run. Ask for the path if it is not given.
2. If the server says darshan-util is missing, look for a module
   (`mcp_hpc__modules_spider` with `name` = `darshan`, see hpc-modules) or
   a Spack install (`mcp_hpc__spack_find` with `spec` = `darshan-util`).
   Without it, stop and say that darshan-util is needed. Never guess counters.
3. Capture with Darshan only when asked: link the runtime library, or preload
   it with `LD_PRELOAD=<darshan lib dir>/libdarshan.so` (`darshan-config --libdir`
   prints that directory). Non-MPI programs also need `DARSHAN_ENABLE_NONMPI=1`.

## Phase 1: summarize

Every tool takes the log as `path` and only reads it.

| Question | Tool |
| --- | --- |
| The job, its modules, and bytes, seconds, opens and rate per module | `mcp_hpc__darshan_summary` |
| Which files carried the I/O | `mcp_hpc__darshan_files`, `module` (`POSIX`, `MPIIO`, `STDIO`), `metric` (`bytesRead`, `bytesWritten`, `readTime`, `writeTime`, `metaTime`, `opens`), `limit` |
| Every counter of one module | `mcp_hpc__darshan_modules`, `module` (`POSIX`, `MPIIO`, `STDIO`, `H5F`, `H5D` and so on) |
| When the I/O happened | `mcp_hpc__darshan_timeline`, `module` |

Start with `darshan_summary`, then `darshan_files` for the top files, then
`darshan_modules` for the counter table below. A module that ran out of record
memory is marked in the summary; the report must then say that the module's
data is incomplete. A counter Darshan did not record comes back null with its
reason: say so, and never read it as zero.

## Phase 2: read the counters

Read each pattern from its counters, and name them:

| Pattern | Counters |
| --- | --- |
| Many small requests | `POSIX_SIZE_WRITE_0_100`, `POSIX_SIZE_WRITE_100_1K` (and `_READ_`) against `POSIX_WRITES` |
| Random rather than sequential | `POSIX_SEQ_WRITES` / `POSIX_WRITES`; `POSIX_SEEKS` |
| Metadata bound | `POSIX_F_META_TIME` against read and write time; `POSIX_OPENS`, `POSIX_STATS` |
| Collective path not taken | `MPIIO_COLL_WRITES` = 0 with `MPIIO_INDEP_WRITES` > 0 |
| Shared-file contention | `shared` file count and bytes, `time_by_slowest` for shared files |
| Achieved rate | `agg_perf_by_slowest` (MiB/s) with `agg_time_by_slowest` |

Ratios you derive (small-request share, sequential share, metadata time share,
collective share) describe the run. They are not verdicts. Name the counters
each one comes from.

## Phase 3: compare runs

To judge a change, summarize both logs and compare the same counters. A rate
change is meaningful only between runs of the same input, the same rank count
and the same file system. Say which of those differ.

## Fallback without the server

Run `darshan-parser` over `bash` and read only its aggregate modes:

- `command -v darshan-parser && darshan-parser --version`; without it, stop as
  in Phase 0.
- `darshan-parser --total <log>`: every counter summed over files and ranks,
  one `<counter>: <value>` line each.
- `darshan-parser --perf <log>`: the job header and the derived rates
  (`agg_perf_by_slowest`, `agg_time_by_slowest`).
- `darshan-parser --file <log>`: file counts and bytes by access type, shared
  and unique.

An incomplete log makes darshan-parser fail. Rerun with `--show-incomplete`
only to look; the report must then say that the module's data is incomplete.
If a field is missing on another darshan-util version, read the raw output
instead of assuming a zero.

## Final answer

Give the log path, the job (`exe`, `nprocs`, `jobid`, run time), the two or
three counters that carry the finding, the tool or command that read them, and
the change they suggest. For parallel HDF5 or MPI-IO fixes, hand over to
hpc-parallel-io.
