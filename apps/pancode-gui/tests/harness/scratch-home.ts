// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function scratchHome() {
	const path = await mkdtemp(join(tmpdir(), "pancode-gui-test-"));
	// Hermetic: the core finds other agents' folders (`~/.claude/skills`, `~/.codex`) through the home
	// directory and these variables, so a fixture that inherits them reads the developer's own machine
	// into its assertions and its screenshots.
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) =>
				!/^XDG_(CONFIG|DATA|STATE|CACHE)_HOME$/.test(key) &&
				![
					"CLAUDE_CONFIG_DIR",
					"CODEX_HOME",
					"ANTIGRAVITY_HOME",
					"OPENCODE_CONFIG_DIR",
					"COPILOT_HOME",
					"GEMINI_CLI_HOME",
				].includes(key),
		),
	);
	const env = {
		...inherited,
		PATH: "",
		HOME: path,
		USERPROFILE: path,
		PANCODE_HOME: path,
		...Object.fromEntries(
			["CONFIG", "DATA", "STATE", "CACHE"].map((role) => [`PANCODE_${role}_DIR`, join(path, role.toLowerCase())]),
		),
	};
	return { path, env, close: () => rm(path, { recursive: true, force: true }) };
}
