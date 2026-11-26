// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * bin/pancode.cjs decides, before dist/ is loaded, whether this Node can run
 * PanCode (#408). Its floor must match package.json engines.node.
 */
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { posix } from "node:path";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const guard = require("../../bin/pancode.cjs") as {
	isSupportedNode: (version: string, min?: number[]) => boolean;
	MIN_NODE: number[];
	updatableRoot: (path: typeof posix, root: string) => boolean;
};

describe("contracts/launcher-guard", () => {
	it("compares major, minor and patch against the engines floor", () => {
		const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
			engines: { node: string };
		};
		deepStrictEqual(`>=${guard.MIN_NODE.join(".")}`, pkg.engines.node);
		for (const [version, supported] of [
			["18.20.8", false],
			["20.19.5", false],
			["22.18.9", false],
			["22.19.0", true],
			["v22.19.1", true],
			["24.0.0", true],
			["garbage", false],
		] as const) {
			strictEqual(guard.isSupportedNode(version), supported, version);
		}
	});

	it("registers sessions for a global install of the scoped package and for nothing else", () => {
		for (const [root, updatable] of [
			["/home/u/.nvm/versions/node/v24.1.0/lib/node_modules/@akougkas/pancode", true],
			["/home/u/.volta/tools/image/packages/pancode/lib/node_modules/@akougkas/pancode", true],
			["/home/u/.bun/install/global/node_modules/@akougkas/pancode", true],
			["/home/u/.local/share/pnpm/global/5/.pnpm/@akougkas+pancode@0.9.0/node_modules/@akougkas/pancode", true],
			["/home/u/.npm/_npx/1a2b3c/node_modules/@akougkas/pancode", false],
			["/home/u/project/node_modules/@akougkas/pancode", false],
			["/home/u/.local/share/pancode-install/versions/0.9.0/lib/node_modules/pancode", false],
			["/home/u/src/pancode", false],
		] as const) {
			strictEqual(guard.updatableRoot(posix, root), updatable, root);
		}
	});
});
