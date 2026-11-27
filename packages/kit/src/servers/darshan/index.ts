// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The `darshan` server: what a Darshan log says about a job's I/O, read
 * through `darshan-parser` and, for DXT traces, `darshan-dxt-parser` from
 * darshan-util. It needs `darshan-parser` on PATH and reads no environment.
 */
import { defineServer } from "@pancode/sdk/tool";
import { DARSHAN_TOOLS, DXT_PARSER, PARSER } from "../../../../../hub/packs/plugins/hpc/src/darshan/tools.js";
import { resolveProgram } from "../../../../../hub/packs/plugins/hpc/src/exec.js";
import type { ServerProbe } from "../../registry.js";

export const server = defineServer({
	id: "darshan",
	version: "0.2.0",
	title: "Darshan I/O traces",
	tools: DARSHAN_TOOLS,
});

/** Available when `darshan-parser` is on PATH; names whether `darshan-dxt-parser` is too, without running either. */
export async function probe(): Promise<ServerProbe> {
	const program = (name: string) => {
		const found = resolveProgram(name, process.env.PATH, process.cwd());
		return found === null ? { name, found: false, detail: "not on PATH" } : { name, found: true, detail: found };
	};
	const parser = program(PARSER);
	const sources = [parser, program(DXT_PARSER)];
	return parser.found
		? { available: true, sources }
		: {
				available: false,
				reason: `${PARSER} is not on PATH; the darshan server needs ${PARSER} from darshan-util to read Darshan logs`,
				sources,
			};
}
