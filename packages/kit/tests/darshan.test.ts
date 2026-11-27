// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { AnyTool } from "@pancode/sdk/tool";
import { runCommand } from "../src/exec.js";
import { probe, server } from "../src/servers/darshan/index.js";
import {
	isRecordLine,
	moduleKey,
	parseDxtSegments,
	parseFileCounts,
	parseHeader,
	parseHeatmap,
	parseIncomplete,
	parseMounts,
	parsePerf,
	parseRecords,
	parseTotals,
	parseVersion,
} from "../src/servers/darshan/parse.js";
import { createDarshanTools, MAX_BINS, MAX_COUNTERS, MAX_FILES } from "../src/servers/darshan/tools.js";

/**
 * The darshan server. Its parsers read text captured from darshan-parser and
 * darshan-dxt-parser 3.6.0 (log format 3.41) on logs a small POSIX and STDIO
 * program wrote under Darshan 3.6.0, trimmed: paths under /home/user1/run,
 * the DXT host name node001, a few mounts, counters and bins kept. Each
 * captured block says what it came from. Constructed by hand, because the
 * build had no MPI: MPI-IO record and total lines, multi-rank records,
 * heatmaps with more than 500 bins or disagreeing widths, the older --perf
 * unit heading, and every malformed input. The tools run in process against
 * stub darshan-parser and darshan-dxt-parser programs that record their argv
 * and environment and print these texts.
 */

/** The header block every mode prints, from the incomplete log: three of its mounts kept. */
const HEADER = `# darshan log version: 3.41
# compression method: ZLIB
# exe: ./iotest /home/user1/run 6 --token=SECRET-TOKEN-123 
# uid: 1000
# jobid: 652963
# start_time: 1795582206
# start_time_asci: Tue Nov 24 22:50:06 2026
# end_time: 1795582209
# end_time_asci: Tue Nov 24 22:50:09 2026
# nprocs: 1
# run time: 2.2295
# metadata: lib_ver = 3.6.0

# log file regions
# -------------------------------------------------------
# header: 1328 bytes (uncompressed)
# job data: 389 bytes (compressed)
# record table: 216 bytes (compressed)
# POSIX module: 248 bytes (compressed), ver=4
# STDIO module: 88 bytes (compressed), ver=2
# HEATMAP module: 88 bytes (compressed), ver=1

# mounted file systems (mount point and fs type)
# -------------------------------------------------------
# mount entry:	/sys/fs/cgroup	cgroup2
# mount entry:	/dev	devtmpfs
# mount entry:	/	ext4
`;

/** `--show-incomplete --total` after the header: POSIX (incomplete) and STDIO, ten counters each kept. */
const TOTAL_BODY = `# *******************************************************
# POSIX module data
# *******************************************************

# *WARNING*: The POSIX module contains incomplete data!

# To avoid this error, consult the darshan-runtime
# documentation and consider setting the NAME_EXCLUDE
# variable in a run-time configuration file to prevent
# Darshan from instrumenting unnecessary files.

# description of POSIX counters:

# WARNING: POSIX_OPENS counter includes both POSIX_FILENOS and POSIX_DUPS counts

# WARNING: POSIX counters related to file offsets may be incorrect if a file is simultaneously accessed by both POSIX and STDIO (e.g., using fileno())

total_POSIX_OPENS: 4
total_POSIX_READS: 50
total_POSIX_WRITES: 48
total_POSIX_MMAPS: -1
total_POSIX_BYTES_READ: 3145728
total_POSIX_BYTES_WRITTEN: 3145728
total_POSIX_FASTEST_RANK: -1
total_POSIX_F_READ_TIME: 0.000203
total_POSIX_F_WRITE_TIME: 0.020410
total_POSIX_F_META_TIME: 0.000217

# *******************************************************
# STDIO module data
# *******************************************************

# description of STDIO counters:

# WARNING: STDIO_OPENS counter includes STDIO_FDOPENS count

# WARNING: STDIO counters related to file offsets may be incorrect if a file is simultaneously accessed by both STDIO and POSIX (e.g., using fdopen())

total_STDIO_OPENS: 2
total_STDIO_READS: 1000
total_STDIO_WRITES: 1000
total_STDIO_BYTES_WRITTEN: 8890
total_STDIO_BYTES_READ: 8890
total_STDIO_FASTEST_RANK: 0
total_STDIO_F_META_TIME: 0.000179
total_STDIO_F_WRITE_TIME: 0.000091
total_STDIO_F_READ_TIME: 0.000059
`;

/** `--show-incomplete --perf` after the header. */
const PERF_BODY = `# *******************************************************
# POSIX module data
# *******************************************************

# *WARNING*: The POSIX module contains incomplete data!

# To avoid this error, consult the darshan-runtime
# documentation and consider setting the NAME_EXCLUDE
# variable in a run-time configuration file to prevent
# Darshan from instrumenting unnecessary files.

# performance
# -----------
# total_bytes: 6291456
#
# I/O timing for unique files (seconds):
# ...........................
# unique files: slowest_rank_io_time: 0.020830
# unique files: slowest_rank_meta_only_time: 0.000217
# unique files: slowest_rank_rw_only_time: 0.020613
# unique files: slowest_rank: 0
#
# I/O timing for shared files (seconds):
# ...........................
# shared files: time_by_slowest: 0.000000
#
# Aggregate performance, including both shared and unique files:
# ...........................
# agg_time_by_slowest: 0.020830 # seconds
# agg_perf_by_slowest: 288.050546 # MiB/s

# *******************************************************
# STDIO module data
# *******************************************************

# performance
# -----------
# total_bytes: 17780
#
# I/O timing for unique files (seconds):
# ...........................
# unique files: slowest_rank_io_time: 0.000328
# unique files: slowest_rank_meta_only_time: 0.000179
# unique files: slowest_rank_rw_only_time: 0.000149
# unique files: slowest_rank: 0
#
# I/O timing for shared files (seconds):
# ...........................
# shared files: time_by_slowest: 0.000000
#
# Aggregate performance, including both shared and unique files:
# ...........................
# agg_time_by_slowest: 0.000328 # seconds
# agg_perf_by_slowest: 51.648511 # MiB/s
`;

/** `--show-incomplete --file` after the header. */
const FILE_BODY = `# *******************************************************
# POSIX module data
# *******************************************************

# *WARNING*: The POSIX module contains incomplete data!

# To avoid this error, consult the darshan-runtime
# documentation and consider setting the NAME_EXCLUDE
# variable in a run-time configuration file to prevent
# Darshan from instrumenting unnecessary files.

# Total file counts
# -----
# <file_type>: type of file access:
# <file_count> total number of files of this type
# <total_bytes> total number of bytes moved to/from files of this type
# <max_byte_offset> maximum byte offset accessed for a file of this type

# <file_type> <file_count> <total_bytes> <max_byte_offset>
# total: 2 6291456 2097151
# read_only: 0 0 0
# write_only: 0 0 0
# read_write: 2 6291456 2097151
# unique: 2 6291456 2097151
# shared: 0 0 0

# *******************************************************
# STDIO module data
# *******************************************************

# Total file counts
# -----
# <file_type>: type of file access:
# <file_count> total number of files of this type
# <total_bytes> total number of bytes moved to/from files of this type
# <max_byte_offset> maximum byte offset accessed for a file of this type

# <file_type> <file_count> <total_bytes> <max_byte_offset>
# total: 1 17780 8889
# read_only: 0 0 0
# write_only: 0 0 0
# read_write: 1 17780 8889
# unique: 1 17780 8889
# shared: 0 0 0
`;

/** `--show-incomplete --base` after the header: seven counters per POSIX and STDIO record, the whole POSIX heatmap and three STDIO bins. */
const BASE_BODY = `# *******************************************************
# POSIX module data
# *******************************************************

# *WARNING*: The POSIX module contains incomplete data!

# To avoid this error, consult the darshan-runtime
# documentation and consider setting the NAME_EXCLUDE
# variable in a run-time configuration file to prevent
# Darshan from instrumenting unnecessary files.

# description of POSIX counters:



#<module>	<rank>	<record id>	<counter>	<value>	<file name>	<mount pt>	<fs type>
POSIX	0	10433320074418710969	POSIX_OPENS	2	/home/user1/run/posix-0.dat	/	ext4
POSIX	0	10433320074418710969	POSIX_MMAPS	-1	/home/user1/run/posix-0.dat	/	ext4
POSIX	0	10433320074418710969	POSIX_BYTES_READ	1048576	/home/user1/run/posix-0.dat	/	ext4
POSIX	0	10433320074418710969	POSIX_BYTES_WRITTEN	1048576	/home/user1/run/posix-0.dat	/	ext4
POSIX	0	10433320074418710969	POSIX_F_READ_TIME	0.000058	/home/user1/run/posix-0.dat	/	ext4
POSIX	0	10433320074418710969	POSIX_F_WRITE_TIME	0.006513	/home/user1/run/posix-0.dat	/	ext4
POSIX	0	10433320074418710969	POSIX_F_META_TIME	0.000113	/home/user1/run/posix-0.dat	/	ext4
POSIX	0	18200709867044722718	POSIX_OPENS	2	/home/user1/run/posix-1.dat	/	ext4
POSIX	0	18200709867044722718	POSIX_MMAPS	-1	/home/user1/run/posix-1.dat	/	ext4
POSIX	0	18200709867044722718	POSIX_BYTES_READ	2097152	/home/user1/run/posix-1.dat	/	ext4
POSIX	0	18200709867044722718	POSIX_BYTES_WRITTEN	2097152	/home/user1/run/posix-1.dat	/	ext4
POSIX	0	18200709867044722718	POSIX_F_READ_TIME	0.000144	/home/user1/run/posix-1.dat	/	ext4
POSIX	0	18200709867044722718	POSIX_F_WRITE_TIME	0.013897	/home/user1/run/posix-1.dat	/	ext4
POSIX	0	18200709867044722718	POSIX_F_META_TIME	0.000103	/home/user1/run/posix-1.dat	/	ext4

# *******************************************************
# STDIO module data
# *******************************************************

# description of STDIO counters:



#<module>	<rank>	<record id>	<counter>	<value>	<file name>	<mount pt>	<fs type>
STDIO	0	16628429239750669093	STDIO_OPENS	2	/home/user1/run/stdio.txt	/	ext4
STDIO	0	16628429239750669093	STDIO_BYTES_WRITTEN	8890	/home/user1/run/stdio.txt	/	ext4
STDIO	0	16628429239750669093	STDIO_BYTES_READ	8890	/home/user1/run/stdio.txt	/	ext4
STDIO	0	16628429239750669093	STDIO_F_META_TIME	0.000179	/home/user1/run/stdio.txt	/	ext4
STDIO	0	16628429239750669093	STDIO_F_WRITE_TIME	0.000091	/home/user1/run/stdio.txt	/	ext4
STDIO	0	16628429239750669093	STDIO_F_READ_TIME	0.000059	/home/user1/run/stdio.txt	/	ext4

# *******************************************************
# HEATMAP module data
# *******************************************************

# description of heatmap counters:

#<module>	<rank>	<record id>	<counter>	<value>	<file name>	<mount pt>	<fs type>
HEATMAP	0	16592106915301738621	HEATMAP_F_BIN_WIDTH_SECONDS	0.100000	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_0	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_1	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_2	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_3	1048576	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_4	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_5	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_6	2097152	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_7	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_8	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_9	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_10	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_11	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_12	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_13	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_14	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_15	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_16	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_17	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_18	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_19	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_20	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_21	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_READ_BIN_22	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_0	1048576	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_1	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_2	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_3	2097152	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_4	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_5	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_6	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_7	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_8	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_9	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_10	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_11	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_12	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_13	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_14	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_15	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_16	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_17	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_18	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_19	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_20	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_21	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	16592106915301738621	HEATMAP_WRITE_BIN_22	0	heatmap:POSIX	UNKNOWN	UNKNOWN
HEATMAP	0	3989511027826779520	HEATMAP_F_BIN_WIDTH_SECONDS	0.100000	heatmap:STDIO	UNKNOWN	UNKNOWN
HEATMAP	0	3989511027826779520	HEATMAP_READ_BIN_0	0	heatmap:STDIO	UNKNOWN	UNKNOWN
HEATMAP	0	3989511027826779520	HEATMAP_READ_BIN_1	0	heatmap:STDIO	UNKNOWN	UNKNOWN
HEATMAP	0	3989511027826779520	HEATMAP_READ_BIN_2	0	heatmap:STDIO	UNKNOWN	UNKNOWN
HEATMAP	0	3989511027826779520	HEATMAP_WRITE_BIN_0	0	heatmap:STDIO	UNKNOWN	UNKNOWN
HEATMAP	0	3989511027826779520	HEATMAP_WRITE_BIN_1	0	heatmap:STDIO	UNKNOWN	UNKNOWN
HEATMAP	0	3989511027826779520	HEATMAP_WRITE_BIN_2	0	heatmap:STDIO	UNKNOWN	UNKNOWN
`;

/** darshan-dxt-parser's header block, from the DXT log. */
const DXT_HEADER = `# darshan log version: 3.41
# compression method: ZLIB
# exe: ./iotest /home/user1/run 3 --token=SECRET-TOKEN-123 
# uid: 1000
# jobid: 652716
# start_time: 1795582204
# start_time_asci: Tue Nov 24 22:50:04 2026
# end_time: 1795582205
# end_time_asci: Tue Nov 24 22:50:05 2026
# nprocs: 1
# run time: 1.2331
# metadata: lib_ver = 3.6.0

# log file regions
# -------------------------------------------------------
# header: 1328 bytes (uncompressed)
# job data: 389 bytes (compressed)
# record table: 187 bytes (compressed)
# POSIX module: 357 bytes (compressed), ver=4
# STDIO module: 83 bytes (compressed), ver=2
# DXT_POSIX module: 1613 bytes (compressed), ver=2

# mounted file systems (mount point and fs type)
# -------------------------------------------------------
# mount entry:	/sys/fs/cgroup	cgroup2
# mount entry:	/dev	devtmpfs
# mount entry:	/	ext4
`;

/** darshan-dxt-parser's segments after the header: the first two writes and reads of each file. */
const DXT_BODY = `# ***************************************************
# DXT_POSIX module data
# ***************************************************

# DXT, file_id: 10436921671919811149, file_name: /home/user1/run/posix-0.dat
# DXT, rank: 0, hostname: node001
# DXT, number of threads: 1
# DXT, write_count: 16, read_count: 17
# DXT, mnt_pt: /, fs_type: ext4
# Module    Rank  Wt/Rd  Segment          Offset          Length    Start(s)      End(s)   Pthread-ID
 X_POSIX       0  write        0               0           65536      0.0017      0.0017   138341167587392
 X_POSIX       0  write        1           65536           65536      0.0017      0.0017   138341167587392
 X_POSIX       0   read        0               0           65536      0.3089      0.3089   138341167587392
 X_POSIX       0   read        1           65536           65536      0.3089      0.3090   138341167587392

# DXT, file_id: 17584019925945111484, file_name: /home/user1/run/posix-1.dat
# DXT, rank: 0, hostname: node001
# DXT, number of threads: 1
# DXT, write_count: 32, read_count: 33
# DXT, mnt_pt: /, fs_type: ext4
# Module    Rank  Wt/Rd  Segment          Offset          Length    Start(s)      End(s)   Pthread-ID
 X_POSIX       0  write        0               0           65536      0.3091      0.3092   138341167587392
 X_POSIX       0  write        1           65536           65536      0.3092      0.3092   138341167587392
 X_POSIX       0   read        0               0           65536      0.6183      0.6183   138341167587392
 X_POSIX       0   read        1           65536           65536      0.6183      0.6183   138341167587392

# DXT, file_id: 17997322081069355588, file_name: /home/user1/run/posix-2.dat
# DXT, rank: 0, hostname: node001
# DXT, number of threads: 1
# DXT, write_count: 48, read_count: 49
# DXT, mnt_pt: /, fs_type: ext4
# Module    Rank  Wt/Rd  Segment          Offset          Length    Start(s)      End(s)   Pthread-ID
 X_POSIX       0  write        0               0           65536      0.6186      0.6187   138341167587392
 X_POSIX       0  write        1           65536           65536      0.6187      0.6188   138341167587392
 X_POSIX       0   read        0               0           65536      0.9326      0.9326   138341167587392
 X_POSIX       0   read        1           65536           65536      0.9326      0.9326   138341167587392
`;

/** darshan-parser --base on the incomplete log without --show-incomplete: its stderr, before it exits 255. */
const NO_FLAG_STDERR = `# *ERROR*: The POSIX module contains incomplete data!
#            This happens when a module runs out of
#            memory to store new record data.
`;

const TOTAL = HEADER + TOTAL_BODY;
const PERF = HEADER + PERF_BODY;
const FILE = HEADER + FILE_BODY;
const BASE = HEADER + BASE_BODY;
const DXT = DXT_HEADER + DXT_BODY;
const MIB = 1024 * 1024;

/** A header naming `modules` in its region table, for constructed outputs. */
function headerWith(modules: ReadonlyArray<string>): string {
	return HEADER.replace(
		/# POSIX module:[^\n]*\n# STDIO module:[^\n]*\n# HEATMAP module:[^\n]*\n/u,
		modules.map((name) => `# ${name} module: 88 bytes (compressed), ver=1\n`).join(""),
	);
}

function record(module: string, rank: number, id: string, counter: string, value: string, file: string): string {
	return [module, String(rank), id, counter, value, file, "/scratch", "lustre"].join("\t");
}

test("parseHeader reads the job and never keeps the executable's arguments", () => {
	const header = parseHeader(TOTAL);
	assert.deepEqual(header, {
		logFormatVersion: "3.41",
		compression: "ZLIB",
		executable: "./iotest",
		uid: 1000,
		jobId: "652963",
		startTime: 1795582206,
		endTime: 1795582209,
		processCount: 1,
		runTimeSeconds: 2.2295,
		libraryVersion: "3.6.0",
		modules: [
			{ name: "POSIX", formatVersion: 4 },
			{ name: "STDIO", formatVersion: 2 },
			{ name: "HEATMAP", formatVersion: 1 },
		],
	});
	assert.doesNotMatch(JSON.stringify(header), /SECRET-TOKEN|user1/u);
	assert.deepEqual(
		parseHeader(DXT)?.modules.map((module) => module.name),
		["POSIX", "STDIO", "DXT_POSIX"],
	);
	assert.equal(parseHeader("Error: darshan_log_open failed to open darshan log file x.\n"), null);
	assert.equal(parseHeader(""), null);
	const broken = parseHeader("# darshan log version: 3.41\n# uid: root\n# nprocs: -4\n# run time: soon\n# exe: \n");
	assert.equal(broken?.uid, null);
	assert.equal(broken?.processCount, null);
	assert.equal(broken?.runTimeSeconds, null);
	assert.equal(broken?.executable, null);
	assert.equal(broken?.startTime, null);
});

test("parseMounts keeps mount point and type, old and new layouts, and skips what it cannot read", () => {
	assert.deepEqual(parseMounts(TOTAL), [
		{ mountPoint: "/sys/fs/cgroup", fsType: "cgroup2" },
		{ mountPoint: "/dev", fsType: "devtmpfs" },
		{ mountPoint: "/", fsType: "ext4" },
	]);
	assert.deepEqual(
		parseMounts("# mount entry:\t2049\t/scratch\tlustre\n# mount entry:\tlustre\n# mount entry:\tnone\tx\n"),
		[{ mountPoint: "/scratch", fsType: "lustre" }],
	);
});

test("parseIncomplete finds the warning --show-incomplete prints and the error without it", () => {
	assert.deepEqual(parseIncomplete(TOTAL), ["POSIX"]);
	assert.deepEqual(parseIncomplete(BASE), ["POSIX"]);
	assert.deepEqual(parseIncomplete(NO_FLAG_STDERR), ["POSIX"]);
	assert.deepEqual(parseIncomplete(DXT), []);
});

test("parseTotals reads each module's counters, -1 as null, and counts lines it cannot read", () => {
	const { modules, malformedLines } = parseTotals(TOTAL);
	assert.equal(malformedLines, 0);
	assert.deepEqual([...modules.keys()], ["POSIX", "STDIO"]);
	const posix = new Map(modules.get("POSIX")?.map((counter) => [counter.name, counter.value]));
	assert.equal(posix.get("POSIX_OPENS"), 4);
	assert.equal(posix.get("POSIX_BYTES_READ"), 3 * MIB);
	assert.equal(posix.get("POSIX_F_WRITE_TIME"), 0.02041);
	assert.equal(posix.get("POSIX_MMAPS"), null);
	assert.equal(posix.get("POSIX_FASTEST_RANK"), null);
	const constructed = parseTotals(
		"# MPI-IO module data\ntotal_MPIIO_INDEP_OPENS: 3\ntotal_MPIIO_COLL_OPENS: 5\ntotal_MPIIO_BYTES_READ: nope\nMPIIO_BYTES_WRITTEN 7\n",
	);
	assert.deepEqual(constructed.modules.get("MPI-IO"), [
		{ name: "MPIIO_INDEP_OPENS", value: 3 },
		{ name: "MPIIO_COLL_OPENS", value: 5 },
		{ name: "MPIIO_BYTES_READ", value: null },
	]);
	assert.equal(constructed.malformedLines, 1);
	assert.equal(moduleKey("MPI-IO"), "MPIIO");
	assert.equal(moduleKey("BG/Q"), "BGQ");
});

test("parsePerf converts the aggregate rate to bytes per second from either unit layout", () => {
	const perf = parsePerf(PERF);
	assert.deepEqual(perf.get("POSIX"), { totalBytes: 6 * MIB, aggregateRateBytesPerSecond: 288.050546 * MIB });
	assert.deepEqual(perf.get("STDIO"), { totalBytes: 17780, aggregateRateBytesPerSecond: 51.648511 * MIB });
	const older = parsePerf(
		"# POSIX module data\n# total_bytes: 10\n# Aggregate performance, including both shared and unique files (MiB/s):\n# agg_perf_by_slowest: 2.5\n",
	);
	assert.equal(older.get("POSIX")?.aggregateRateBytesPerSecond, 2.5 * MIB);
	const odd = parsePerf(
		"# POSIX module data\n# agg_perf_by_slowest: 2.5 # furlongs/s\n# STDIO module data\n# agg_perf_by_slowest: 2.5\n# H5F module data\n",
	);
	assert.match(odd.get("POSIX")?.rateReason ?? "", /furlongs\/s/u);
	assert.match(odd.get("STDIO")?.rateReason ?? "", /without a unit/u);
	assert.match(odd.get("H5F")?.rateReason ?? "", /printed no agg_perf_by_slowest/u);
	assert.equal(odd.get("H5F")?.aggregateRateBytesPerSecond, null);
});

test("parseFileCounts reads the total row of --file", () => {
	assert.deepEqual(
		[...parseFileCounts(FILE)],
		[
			["POSIX", 2],
			["STDIO", 1],
		],
	);
	assert.deepEqual([...parseFileCounts("# POSIX module data\n# total: many 1 2\n")], [["POSIX", null]]);
});

test("parseRecords groups --base lines into records per rank and file and counts malformed lines", () => {
	const posix = parseRecords(BASE, "POSIX");
	assert.equal(posix.malformedLines, 0);
	assert.deepEqual(
		posix.records.map((entry) => [entry.path, entry.rank, entry.counters.get("POSIX_BYTES_READ")]),
		[
			["/home/user1/run/posix-0.dat", 0, MIB],
			["/home/user1/run/posix-1.dat", 0, 2 * MIB],
		],
	);
	assert.equal(posix.records[0]?.counters.get("POSIX_MMAPS"), null);
	assert.equal(posix.records[0]?.mountPoint, "/");
	assert.equal(posix.records[0]?.fsType, "ext4");
	const stdio = parseRecords(BASE, "STDIO");
	assert.deepEqual(
		stdio.records.map((entry) => [entry.path, entry.counters.get("STDIO_OPENS")]),
		[["/home/user1/run/stdio.txt", 2]],
	);
	const text = [
		record("MPI-IO", 0, "11", "MPIIO_BYTES_READ", "10", "/scratch/a"),
		record("MPI-IO", 1, "11", "MPIIO_BYTES_READ", "20", "/scratch/a"),
		record("MPI-IO", -1, "12", "MPIIO_BYTES_READ", "-1", "/scratch/b"),
		"MPI-IO\t0\t11\tMPIIO_BYTES_READ\t10\t/scratch/a",
		record("MPI-IO", 0, "x1", "MPIIO_BYTES_READ", "10", "/scratch/a"),
		record("POSIX", 0, "13", "POSIX_OPENS", "1", "/scratch/c"),
	].join("\n");
	const mpi = parseRecords(text, "MPIIO");
	assert.deepEqual(
		mpi.records.map((entry) => [entry.module, entry.rank, entry.recordId, entry.counters.get("MPIIO_BYTES_READ")]),
		[
			["MPI-IO", 0, "11", 10],
			["MPI-IO", 1, "11", 20],
			["MPI-IO", -1, "12", null],
		],
	);
	assert.equal(mpi.malformedLines, 2);
	assert.equal(isRecordLine(record("MPI-IO", 0, "1", "MPIIO_X", "1", "/a"), "MPIIO"), true);
	assert.equal(isRecordLine("#<module>\t<rank>", "POSIX"), false);
});

test("parseHeatmap sums one module's bins over ranks and refuses disagreeing widths", () => {
	const { heatmap } = parseHeatmap(BASE, "POSIX");
	assert.equal(heatmap?.binWidthSeconds, 0.1);
	assert.equal(heatmap?.readBytes.length, 23);
	assert.equal(heatmap?.writeBytes[0], MIB);
	assert.equal(heatmap?.readBytes[3], MIB);
	assert.equal(heatmap?.writeBytes[3], 2 * MIB);
	assert.equal(heatmap?.readBytes[6], 2 * MIB);
	assert.equal(parseHeatmap(BASE, "STDIO").heatmap?.readBytes.length, 3);
	assert.deepEqual(parseHeatmap(BASE, "MPIIO"), { heatmap: null });
	const ranks = [0, 1]
		.flatMap((rank) => [
			record("HEATMAP", rank, "9", "HEATMAP_F_BIN_WIDTH_SECONDS", "0.200000", "heatmap:MPIIO"),
			record("HEATMAP", rank, "9", "HEATMAP_READ_BIN_1", "5", "heatmap:MPIIO"),
			record("HEATMAP", rank, "9", "HEATMAP_WRITE_BIN_0", "7", "heatmap:MPIIO"),
		])
		.join("\n");
	assert.deepEqual(parseHeatmap(ranks, "MPIIO").heatmap, {
		binWidthSeconds: 0.2,
		readBytes: [0, 10],
		writeBytes: [14, 0],
	});
	const mismatch = `${ranks}\n${record("HEATMAP", 2, "9", "HEATMAP_F_BIN_WIDTH_SECONDS", "0.4", "heatmap:MPIIO")}`;
	assert.match(parseHeatmap(mismatch, "MPIIO").reason ?? "", /different bin widths/u);
	const widthless = record("HEATMAP", 0, "9", "HEATMAP_READ_BIN_0", "5", "heatmap:POSIX");
	assert.match(parseHeatmap(widthless, "POSIX").reason ?? "", /no bin width/u);
});

test("parseDxtSegments reads segments, never the host name, and counts malformed lines", () => {
	const { segments, malformedLines } = parseDxtSegments(DXT);
	assert.equal(malformedLines, 0);
	assert.equal(segments.length, 12);
	assert.deepEqual(segments[0], {
		module: "POSIX",
		rank: 0,
		operation: "write",
		offset: 0,
		lengthBytes: 65536,
		startSeconds: 0.0017,
		endSeconds: 0.0017,
	});
	assert.doesNotMatch(JSON.stringify(segments), /node001/u);
	const constructed = parseDxtSegments(
		[
			"  X_MPIIO       3   read        0               0            4096      1.5000      1.2500",
			"  X_POSIX       0  erase        0               0           65536      0.0017      0.0017",
			"  X_POSIX       0  write",
		].join("\n"),
	);
	assert.deepEqual(
		constructed.segments.map((segment) => [segment.module, segment.rank, segment.endSeconds]),
		[["MPIIO", 3, 1.5]],
	);
	assert.equal(constructed.malformedLines, 2);
});

test("parseVersion takes the version line and nothing else", () => {
	assert.equal(parseVersion("3.6.0\n"), "3.6.0");
	assert.equal(parseVersion("3.4.0-pre1\n"), "3.4.0-pre1");
	assert.equal(parseVersion("usage: darshan-parser [options] <filename>\n"), null);
});

test("runCommand's keepLine drops lines before the cap counts them and keeps only whole lines", {
	skip: process.platform === "win32",
}, async () => {
	const script = (text: string) => ["-e", `process.stdout.write(${JSON.stringify(text)})`];
	const lines = `${Array.from({ length: 2000 }, (_, index) => `drop ${index}`).join("\n")}\nkeep a\nkeep b\nkeep c`;
	const kept = await runCommand(process.execPath, script(lines), {
		timeoutMs: 10_000,
		maxOutputBytes: 64,
		keepLine: (line) => line.startsWith("keep"),
	});
	assert.equal(kept.kind, "ok");
	assert.equal(kept.stdout, "keep a\nkeep b\nkeep c", "dropped lines do not count and the last line is flushed");
	assert.equal(kept.truncated, false);

	const cut = await runCommand(process.execPath, script("keep 1\nkeep 2\nkeep 3\n"), {
		timeoutMs: 10_000,
		maxOutputBytes: 16,
		keepLine: () => true,
	});
	assert.equal(cut.stdout, "keep 1\nkeep 2\n");
	assert.equal(cut.truncated, true);

	const overlong = await runCommand(process.execPath, script(`keep ${"x".repeat(200)}\nkeep short\n`), {
		timeoutMs: 10_000,
		maxOutputBytes: 32,
		keepLine: () => true,
	});
	assert.equal(overlong.stdout, "");
	assert.equal(overlong.truncated, true);

	const plain = await runCommand(process.execPath, script("abcdef\nghij"), { timeoutMs: 10_000, maxOutputBytes: 8 });
	assert.equal(plain.stdout, "abcdef\ng", "without keepLine the cap still cuts mid-line as before");
	assert.equal(plain.truncated, true);
});

interface Response {
	stdout?: string;
	stderr?: string;
	code?: number;
}

interface Call {
	name: string;
	args: string[];
	lcAll: string | null;
	envKeys: string[];
}

const STUB = `const fs = require("node:fs");
const path = require("node:path");
const [name, ...args] = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ name, args, lcAll: process.env.LC_ALL ?? null, envKeys: Object.keys(process.env).sort() }) + "\\n");
const responses = JSON.parse(fs.readFileSync(path.join(__dirname, "responses.json"), "utf8"));
const mode = args.find((arg) => arg.startsWith("--") && arg !== "--show-incomplete") ?? "";
const response = responses[name + " " + mode];
if (response === undefined) { process.stderr.write("stub has no response for " + name + " " + mode + "\\n"); process.exit(3); }
process.stderr.write(response.stderr ?? "");
process.stdout.write(response.stdout ?? "", () => process.exit(response.code ?? 0));
`;

/** A directory holding stub darshan programs that answer from `responses`, keyed `<program> <mode>`. */
function stubs(responses: Record<string, Response>): { dir: string; calls(): Call[] } {
	const dir = mkdtempSync(join(tmpdir(), "pankit-darshan-"));
	writeFileSync(join(dir, "stub.cjs"), STUB);
	writeFileSync(join(dir, "responses.json"), JSON.stringify(responses));
	writeFileSync(join(dir, "calls.jsonl"), "");
	for (const name of ["darshan-parser", "darshan-dxt-parser"]) {
		const file = join(dir, name);
		writeFileSync(
			file,
			`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, "stub.cjs"))} ${name} "$@"\n`,
		);
		chmodSync(file, 0o755);
	}
	return {
		dir,
		calls: () =>
			readFileSync(join(dir, "calls.jsonl"), "utf8")
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as Call),
	};
}

const VERSION: Record<string, Response> = {
	"darshan-parser --version": { stdout: "3.6.0\n" },
	"darshan-dxt-parser --version": { stdout: "3.6.0\n" },
};

const context = { signal: new AbortController().signal, log: () => {}, progress: () => {} };

/** Run `body` with `PATH` set to `dir` alone. */
async function withPath<T>(dir: string, body: () => Promise<T>): Promise<T> {
	const saved = process.env.PATH;
	process.env.PATH = dir;
	try {
		return await body();
	} finally {
		process.env.PATH = saved;
	}
}

function tool(name: string, tools: ReadonlyArray<AnyTool> = server.tools): AnyTool {
	const found = tools.find((entry) => entry.name === name);
	assert.ok(found, name);
	return found;
}

async function run(name: string, args: Record<string, unknown>, tools?: ReadonlyArray<AnyTool>) {
	return (await tool(name, tools).run(args as never, context)) as { json?: Record<string, unknown>; error?: string };
}

async function call(
	name: string,
	args: Record<string, unknown>,
	tools?: ReadonlyArray<AnyTool>,
): Promise<Record<string, unknown>> {
	const result = await run(name, args, tools);
	assert.ok(result.json !== undefined, JSON.stringify(result));
	return result.json;
}

const skipOnWindows = { skip: process.platform === "win32" };

test("the server offers four read tools that each take a read path", () => {
	assert.equal(server.id, "darshan");
	assert.deepEqual(
		server.tools.map((entry) => [entry.name, entry.actionClass, entry.pathArguments]),
		["darshan_summary", "darshan_files", "darshan_modules", "darshan_timeline"].map((name) => [
			name,
			"read",
			{ path: "read" },
		]),
	);
});

test(
	"darshan_summary runs only the summary modes, with LC_ALL=C and a minimal environment",
	skipOnWindows,
	async () => {
		const stub = stubs({
			...VERSION,
			"darshan-parser --total": { stdout: TOTAL },
			"darshan-parser --perf": { stdout: PERF },
			"darshan-parser --file": { stdout: FILE },
		});
		process.env.PANKIT_DARSHAN_TEST_SECRET = "do-not-pass";
		let summary: Record<string, unknown>;
		try {
			summary = await withPath(stub.dir, () => call("darshan_summary", { path: "logs/run.darshan" }));
		} finally {
			delete process.env.PANKIT_DARSHAN_TEST_SECRET;
		}
		const log = resolve("logs/run.darshan");
		const calls = stub.calls();
		assert.deepEqual(calls[0]?.args, ["--version"]);
		assert.deepEqual(
			calls
				.slice(1)
				.map((entry) => entry.args)
				.sort(),
			[
				["--show-incomplete", "--file", log],
				["--show-incomplete", "--perf", log],
				["--show-incomplete", "--total", log],
			],
		);
		for (const entry of calls) {
			assert.equal(entry.name, "darshan-parser");
			assert.equal(entry.lcAll, "C");
			assert.ok(!entry.envKeys.includes("PANKIT_DARSHAN_TEST_SECRET"));
			assert.ok(!entry.args.includes("--base") && !entry.args.includes("--all"));
		}
		assert.equal(summary.path, log);
		assert.equal(summary.programVersion, "3.6.0");
		assert.equal(summary.logFormatVersion, "3.41");
		assert.deepEqual(summary.job, {
			executable: "./iotest",
			uid: 1000,
			jobId: "652963",
			startTime: 1795582206,
			endTime: 1795582209,
			processCount: 1,
			runTimeSeconds: 2.2295,
		});
		assert.doesNotMatch(JSON.stringify(summary), /SECRET-TOKEN/u);
		assert.equal(summary.mountCount, 3);
		assert.equal(summary.mountsTruncated, false);
		assert.deepEqual(summary.modulesPresent, ["POSIX", "STDIO", "HEATMAP"]);
		assert.deepEqual(summary.incompleteModules, ["POSIX"]);
		assert.match((summary.notes as string[]).join(" "), /POSIX figures are lower bounds/u);
		assert.equal(summary.complete, true);
		const [posix, stdio] = summary.modules as Array<Record<string, unknown>>;
		assert.deepEqual(posix, {
			name: "POSIX",
			incomplete: true,
			bytesRead: 3 * MIB,
			bytesWritten: 3 * MIB,
			readTimeSeconds: 0.000203,
			writeTimeSeconds: 0.02041,
			metaTimeSeconds: 0.000217,
			opens: 4,
			filesAccessed: 2,
			aggregateRateBytesPerSecond: 288.050546 * MIB,
			unavailable: {},
		});
		assert.equal(stdio?.incomplete, false);
		assert.equal(stdio?.opens, 2);
		assert.equal(stdio?.bytesWritten, 8890);
	},
);

test("darshan_summary caps the mounts and gives a reason for every counter it cannot read", skipOnWindows, async () => {
	const mounts = Array.from({ length: 70 }, (_, index) => `# mount entry:\t/m${index}\text4`).join("\n");
	const total = `${HEADER.replace(/# mount entry:[^\n]*\n/gu, "")}${mounts}\n\n# POSIX module data\ntotal_POSIX_OPENS: -1\ntotal_POSIX_BYTES_READ: 5\n`;
	const stub = stubs({
		...VERSION,
		"darshan-parser --total": { stdout: total },
		"darshan-parser --perf": { stdout: HEADER },
		"darshan-parser --file": { stdout: HEADER },
	});
	const summary = await withPath(stub.dir, () => call("darshan_summary", { path: "/logs/run.darshan" }));
	assert.equal((summary.mounts as unknown[]).length, 64);
	assert.equal(summary.mountCount, 70);
	assert.equal(summary.mountsTruncated, true);
	const [posix] = summary.modules as Array<Record<string, unknown>>;
	assert.equal(posix?.bytesRead, 5);
	assert.equal(posix?.opens, null);
	const unavailable = posix?.unavailable as Record<string, string>;
	for (const [field, value] of Object.entries(posix ?? {}))
		if (value === null) assert.ok(unavailable[field], `${field} is null without a reason`);
	assert.match(unavailable.opens ?? "", /did not record POSIX_OPENS/u);
	assert.match(unavailable.bytesWritten ?? "", /prints no POSIX_BYTES_WRITTEN/u);
});

test("darshan_files ranks one module's files by a counter and caps the list", skipOnWindows, async () => {
	const stub = stubs({ ...VERSION, "darshan-parser --base": { stdout: BASE } });
	const files = await withPath(stub.dir, () => call("darshan_files", { path: "/logs/run.darshan", limit: 1 }));
	assert.deepEqual(stub.calls()[1]?.args, ["--show-incomplete", "--base", "/logs/run.darshan"]);
	assert.equal(stub.calls()[1]?.lcAll, "C");
	assert.equal(files.module, "POSIX");
	assert.equal(files.metric, "bytesRead");
	assert.equal(files.cap, MAX_FILES);
	assert.equal(files.total, 2);
	assert.equal(files.truncated, true);
	assert.equal(files.complete, true);
	assert.equal(files.incomplete, true);
	assert.deepEqual(files.files, [
		{
			path: "/home/user1/run/posix-1.dat",
			mountPoint: "/",
			fsType: "ext4",
			shared: false,
			records: 1,
			bytesRead: 2 * MIB,
			bytesWritten: 2 * MIB,
			readTimeSeconds: 0.000144,
			writeTimeSeconds: 0.013897,
			metaTimeSeconds: 0.000103,
			opens: 2,
		},
	]);
	const many = await withPath(stub.dir, () => call("darshan_files", { path: "/logs/run.darshan", limit: 500 }));
	assert.equal(many.limit, MAX_FILES);
	const absent = await withPath(stub.dir, () => call("darshan_files", { path: "/logs/run.darshan", module: "MPIIO" }));
	assert.equal(absent.files, null);
	assert.match(
		(absent.unavailable as Record<string, string>).files ?? "",
		/no MPIIO module data; it has POSIX, STDIO, HEATMAP/u,
	);
});

test(
	"darshan_files sums a file over ranks and sorts a counter Darshan did not record last",
	skipOnWindows,
	async () => {
		const lines = [
			record("MPI-IO", 0, "11", "MPIIO_BYTES_READ", "10", "/scratch/a"),
			record("MPI-IO", 1, "11", "MPIIO_BYTES_READ", "20", "/scratch/a"),
			record("MPI-IO", -1, "12", "MPIIO_BYTES_READ", "-1", "/scratch/b"),
			record("MPI-IO", 0, "13", "MPIIO_BYTES_READ", "25", "/scratch/c"),
		];
		const text = `${headerWith(["MPI-IO"])}\n# MPI-IO module data\n${lines.join("\n")}\n`;
		const stub = stubs({ ...VERSION, "darshan-parser --base": { stdout: text } });
		const files = await withPath(stub.dir, () => call("darshan_files", { path: "/run.darshan", module: "MPIIO" }));
		const rows = files.files as Array<Record<string, unknown>>;
		assert.deepEqual(
			rows.map((row) => [row.path, row.bytesRead, row.records, row.shared]),
			[
				["/scratch/a", 30, 2, false],
				["/scratch/c", 25, 1, false],
				["/scratch/b", null, 1, true],
			],
		);
		assert.match(JSON.stringify(rows[2]?.unavailable), /did not record MPIIO_BYTES_READ/u);
		assert.match(JSON.stringify(rows[0]?.unavailable), /prints no MPIIO_INDEP_OPENS/u);
	},
);

test("darshan_files on output cut at the cap says the figures are partial", skipOnWindows, async () => {
	const lines = Array.from({ length: 400 }, (_, index) =>
		record("POSIX", 0, String(1000 + index), "POSIX_BYTES_READ", String(index), `/scratch/f${index}`),
	);
	const noise = Array.from({ length: 400 }, (_, index) => record("STDIO", 0, String(index), "STDIO_OPENS", "1", "/x"));
	const text = `${HEADER}\n# POSIX module data\n${lines.join("\n")}\n# STDIO module data\n${noise.join("\n")}\n`;
	const stub = stubs({ ...VERSION, "darshan-parser --base": { stdout: text } });
	const tools = createDarshanTools({ recordOutputBytes: 8 * 1024 });
	const files = await withPath(stub.dir, () => call("darshan_files", { path: "/run.darshan" }, tools));
	assert.equal(files.complete, false);
	assert.match((files.notes as string[]).join(" "), /cover only part of the log/u);
	assert.equal(files.malformedLines, 0, "the cut never leaves half a record");
	assert.ok((files.total as number) > 0 && (files.total as number) < 400);
	const early = stubs({
		...VERSION,
		"darshan-parser --base": { stdout: `${HEADER}${"#".repeat(10_000)}\n${lines.join("\n")}\n` },
	});
	const none = await withPath(early.dir, () => call("darshan_files", { path: "/run.darshan" }, tools));
	assert.equal(none.files, null);
	assert.equal(none.complete, false);
	assert.match((none.unavailable as Record<string, string>).files ?? "", /cut before any POSIX record/u);
});

test(
	"darshan_modules returns one module's counters by name, capped, and says when the module is absent",
	skipOnWindows,
	async () => {
		const stub = stubs({ ...VERSION, "darshan-parser --total": { stdout: TOTAL } });
		const stdio = await withPath(stub.dir, () => call("darshan_modules", { path: "/run.darshan", module: "STDIO" }));
		assert.deepEqual(stub.calls()[1]?.args, ["--show-incomplete", "--total", "/run.darshan"]);
		assert.equal(stdio.module, "STDIO");
		assert.equal(stdio.incomplete, false);
		assert.deepEqual((stdio.counters as unknown[]).slice(0, 2), [
			{ name: "STDIO_OPENS", value: 2 },
			{ name: "STDIO_READS", value: 1000 },
		]);
		const posix = await withPath(stub.dir, () => call("darshan_modules", { path: "/run.darshan" }));
		assert.equal(posix.incomplete, true);
		assert.deepEqual(
			(posix.counters as Array<{ name: string; value: unknown }>).find((entry) => entry.name === "POSIX_MMAPS"),
			{
				name: "POSIX_MMAPS",
				value: null,
			},
		);
		const absent = await withPath(stub.dir, () => call("darshan_modules", { path: "/run.darshan", module: "H5F" }));
		assert.equal(absent.counters, null);
		assert.match((absent.unavailable as Record<string, string>).counters ?? "", /no H5F module data/u);
		const refused = await withPath(stub.dir, () => run("darshan_modules", { path: "/run.darshan", module: "posix; rm" }));
		assert.match(refused.error ?? "", /module must match/u);

		const counters = Array.from({ length: MAX_COUNTERS + 100 }, (_, index) => `total_POSIX_C${index}: ${index}`);
		const wide = stubs({
			...VERSION,
			"darshan-parser --total": { stdout: `${HEADER}\n# POSIX module data\n${counters.join("\n")}\n` },
		});
		const capped = await withPath(wide.dir, () => call("darshan_modules", { path: "/run.darshan" }));
		assert.equal((capped.counters as unknown[]).length, MAX_COUNTERS);
		assert.equal(capped.total, MAX_COUNTERS + 100);
		assert.equal(capped.truncated, true);
	},
);

test("darshan_timeline reads the heatmap and merges bins to fit the cap", skipOnWindows, async () => {
	const stub = stubs({ ...VERSION, "darshan-parser --base": { stdout: BASE } });
	const timeline = await withPath(stub.dir, () => call("darshan_timeline", { path: "/run.darshan" }));
	assert.equal(stub.calls().length, 2, "no DXT parser when the heatmap answers");
	assert.equal(timeline.available, true);
	assert.equal(timeline.source, "heatmap");
	assert.equal(timeline.binWidthSeconds, 0.1);
	assert.equal(timeline.jobStartTime, 1795582206);
	const bins = timeline.bins as Array<{ offsetSeconds: number; readBytes: number; writeBytes: number }>;
	assert.equal(bins.length, 23);
	assert.deepEqual(bins[3], { offsetSeconds: 0.3, readBytes: MIB, writeBytes: 2 * MIB });

	const wide = [
		record("HEATMAP", 0, "9", "HEATMAP_F_BIN_WIDTH_SECONDS", "0.100000", "heatmap:POSIX"),
		...Array.from({ length: 1200 }, (_, index) =>
			record("HEATMAP", 0, "9", `HEATMAP_WRITE_BIN_${index}`, "1", "heatmap:POSIX"),
		),
	];
	const long = stubs({
		...VERSION,
		"darshan-parser --base": {
			stdout: `${headerWith(["POSIX", "HEATMAP"])}\n# HEATMAP module data\n${wide.join("\n")}\n`,
		},
	});
	const merged = await withPath(long.dir, () => call("darshan_timeline", { path: "/run.darshan" }));
	const mergedBins = merged.bins as Array<{ offsetSeconds: number; writeBytes: number }>;
	assert.equal(merged.coarsened, true);
	assert.equal(merged.sourceBinWidthSeconds, 0.1);
	assert.equal(merged.binWidthSeconds, 0.3);
	assert.equal(merged.binCap, MAX_BINS);
	assert.equal(mergedBins.length, 400);
	assert.deepEqual(mergedBins[1], { offsetSeconds: 0.3, readBytes: 0, writeBytes: 3 });
	assert.equal(
		mergedBins.reduce((sum, bin) => sum + bin.writeBytes, 0),
		1200,
	);
});

test("darshan_timeline falls back to the DXT trace, and is unavailable with neither", skipOnWindows, async () => {
	const stub = stubs({
		...VERSION,
		"darshan-parser --base": { stdout: DXT_HEADER },
		"darshan-dxt-parser ": { stdout: DXT },
	});
	const timeline = await withPath(stub.dir, () => call("darshan_timeline", { path: "/run.darshan" }));
	const dxtCall = stub.calls().find((entry) => entry.name === "darshan-dxt-parser" && !entry.args.includes("--version"));
	assert.deepEqual(dxtCall?.args, ["--show-incomplete", "/run.darshan"]);
	assert.equal(dxtCall?.lcAll, "C");
	assert.equal(timeline.source, "dxt");
	assert.equal(timeline.program, "darshan-dxt-parser");
	assert.equal(timeline.binWidthSeconds, 0.005);
	const bins = timeline.bins as Array<{ offsetSeconds: number; readBytes: number; writeBytes: number }>;
	assert.equal(bins.length, 247);
	assert.deepEqual(bins[0], { offsetSeconds: 0, readBytes: 0, writeBytes: 131072 });
	assert.deepEqual(bins[61], { offsetSeconds: 0.305, readBytes: 131072, writeBytes: 131072 });
	assert.equal(
		bins.reduce((sum, bin) => sum + bin.readBytes + bin.writeBytes, 0),
		12 * 65536,
	);
	assert.doesNotMatch(JSON.stringify(timeline), /node001/u);

	const neither = stubs({ ...VERSION, "darshan-parser --base": { stdout: headerWith(["POSIX", "STDIO"]) } });
	const unavailable = await withPath(neither.dir, () => call("darshan_timeline", { path: "/run.darshan" }));
	assert.equal(unavailable.available, false);
	assert.match(unavailable.reason as string, /no HEATMAP module data; the log has no DXT_POSIX trace/u);
	assert.ok(neither.calls().every((entry) => entry.name === "darshan-parser"));
	const stdio = await withPath(neither.dir, () => call("darshan_timeline", { path: "/run.darshan", module: "STDIO" }));
	assert.match(stdio.reason as string, /no DXT trace of STDIO/u);
});

test(
	"a path that could be an option, or a log the parser refuses, spawns nothing or reports the parser's error",
	skipOnWindows,
	async () => {
		const stub = stubs({
			...VERSION,
			"darshan-parser --total": {
				stderr:
					"Error: unable to parse log file format version.\nError: darshan_log_open failed to read darshan log file header: Success.\n",
				code: 255,
			},
			"darshan-parser --perf": { stdout: PERF },
			"darshan-parser --file": { stdout: FILE },
		});
		for (const path of ["--all", "-", "/logs/a\nb"]) {
			const refused = await withPath(stub.dir, () => run("darshan_summary", { path }));
			assert.ok(refused.error !== undefined, path);
		}
		assert.equal(stub.calls().length, 0);
		const broken = await withPath(stub.dir, () => run("darshan_summary", { path: "/logs/not-a-log" }));
		assert.equal(broken.error, "darshan_summary: darshan-parser: Error: unable to parse log file format version.");
	},
);

test("without darshan-parser every tool says so and the probe reports the server unavailable", async () => {
	const empty = mkdtempSync(join(tmpdir(), "pankit-darshan-path-"));
	for (const name of ["darshan_summary", "darshan_files", "darshan_modules", "darshan_timeline"]) {
		const result = await withPath(empty, () => run(name, { path: "/run.darshan" }));
		assert.equal(
			result.error,
			`${name}: darshan-parser is not on PATH; the darshan server needs darshan-parser from darshan-util to read Darshan logs`,
		);
	}
	const probed = await withPath(empty, () => probe());
	assert.equal(probed.available, false);
	assert.match(probed.reason ?? "", /darshan-parser is not on PATH/u);
	assert.deepEqual(
		probed.sources?.map((source) => [source.name, source.found]),
		[
			["darshan-parser", false],
			["darshan-dxt-parser", false],
		],
	);
});
