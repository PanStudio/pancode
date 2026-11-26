// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The `node` server: facts about the machine PanKit runs on. `node:os`
 * answers on every platform, so the server is always available; `/proc`,
 * `lscpu`, `nvidia-smi` and `ps` add facts where they are present.
 */
import { existsSync } from "node:fs";
import { defineServer } from "@pancode/sdk/tool";
import { resolveProgram } from "../../exec.js";
import type { ServerProbe } from "../../registry.js";
import { NODE_TOOLS } from "./tools.js";

export const server = defineServer({ id: "node", version: "0.1.0", title: "Node facts", tools: NODE_TOOLS });

/** Available everywhere; names which optional sources this host has, looking them up without running any. */
export async function probe(): Promise<ServerProbe> {
	const proc = process.platform === "linux" && existsSync("/proc/self");
	const program = (name: string) => {
		const found = resolveProgram(name, process.env.PATH, process.cwd());
		return found === null ? { name, found: false, detail: "not on PATH" } : { name, found: true, detail: found };
	};
	return {
		available: true,
		sources: [
			proc ? { name: "/proc", found: true } : { name: "/proc", found: false, detail: "not available on this platform" },
			program("lscpu"),
			program("nvidia-smi"),
			program("ps"),
		],
	};
}
