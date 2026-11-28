// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** `safety.homeReads` roots and toolchain paths, pure so settings validation can load them. */
import { homedir } from "node:os";
import path from "node:path";
import { isSameOrDescendant } from "../path-containment.js";
import type { HomeReadList, HomeReadMode, HomeReadToolchain } from "./types.js";

/**
 * The home paths each toolchain name shows back. Fixed spellings under the
 * home: never read from the environment or PATH, which a repository's
 * `.envrc` or a shell profile can point anywhere.
 */
export const HOME_READ_TOOLCHAIN_PATHS: Readonly<Record<HomeReadToolchain, ReadonlyArray<string>>> = {
	nvm: [".nvm"],
	pyenv: [".pyenv"],
	// rustup installs its cargo and rustc proxies in ~/.cargo/bin.
	rustup: [".rustup", ".cargo"],
	cargo: [".cargo"],
	go: ["go", ".config/go"],
	uv: [".local/share/uv", ".config/uv", ".local/bin/uv", ".local/bin/uvx"],
};

/** `safety.homeReads` as the settings hold it. */
export interface HomeReadsSetting {
	main: HomeReadMode;
	workers: HomeReadMode;
	roots: ReadonlyArray<string>;
	toolchains: ReadonlyArray<HomeReadToolchain>;
}

/** What one caller's sandbox shows back under `listed`, or undefined when it reads the whole filesystem. */
export function homeReadList(setting: HomeReadsSetting, caller: "main" | "workers"): HomeReadList | undefined {
	if (setting[caller] !== "listed") return undefined;
	return { roots: [...setting.roots], toolchains: [...setting.toolchains] };
}

/** A configured root as a path: `~/` means the home of the host the command runs on. */
function expandHomeReadRoot(root: string, home: string = homedir()): string {
	return root.startsWith("~/") ? path.join(home, root.slice(2)) : path.resolve(root);
}

/**
 * Why a configured root cannot be listed, or null. Checked here against this
 * host's home; every launch checks the physical path again on the host it runs.
 */
export function homeReadRootProblem(root: string, home: string = homedir()): string | null {
	if (root.includes("\0")) return "must not contain a NUL byte";
	if (root === "~" || root === "~/") return "must not be the home directory or one of its ancestors";
	if (!root.startsWith("~/") && !path.isAbsolute(root)) return "must be an absolute path or start with ~/";
	const resolved = expandHomeReadRoot(root, home);
	if (resolved === path.parse(resolved).root) return "must not be the filesystem root";
	if (isSameOrDescendant(home, resolved)) return "must not be the home directory or one of its ancestors";
	return null;
}

/** Every path a list names, as spelled on a host whose home is `home`: the roots, then each toolchain's paths. */
export function listedHomePaths(list: HomeReadList, home: string = homedir()): string[] {
	return [
		...new Set([
			...list.roots.map((root) => expandHomeReadRoot(root, home)),
			...list.toolchains.flatMap((name) => HOME_READ_TOOLCHAIN_PATHS[name].map((entry) => path.join(home, entry))),
		]),
	];
}
