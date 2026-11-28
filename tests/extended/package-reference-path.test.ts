// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal package syntax is the input under test.
import { strictEqual, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { resolvePackPathReference } from "../../src/domains/agents/pack-references.js";

it("validates complete package argument paths instead of a prefix before spaces or Unicode", () => {
	const scratch = mkdtempSync(join(tmpdir(), "pancode-package-path-"));
	try {
		const root = join(scratch, "package 'quoted' α");
		mkdirSync(join(root, "safe"), { recursive: true });
		for (const name of ["safe dir", "safeα", "safe[part]"]) mkdirSync(join(root, name));
		writeFileSync(join(scratch, "outside.txt"), "outside package");
		const context = { rootPath: root, plugin: true };
		for (const directory of ["safe dir", "safeα", "safe[part]"])
			throws(() => resolvePackPathReference(`\${pluginRoot}/${directory}/../../outside.txt`, context), /escaping/);
		const file = join(root, "safe dir", "α 'quoted'.txt");
		writeFileSync(file, "contained evidence");
		strictEqual(
			readFileSync(resolvePackPathReference("${pluginRoot}/safe dir/α 'quoted'.txt", context), "utf8"),
			"contained evidence",
		);
		writeFileSync(
			join(root, "plugin.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
				name: "path-fixture",
				version: "1.0.0",
				extensions: {
					"dev.pancode": {
						manifestVersion: 1,
						components: [{ kind: "resource", id: "evidence", path: "safe dir/α 'quoted'.txt" }],
					},
				},
			}),
		);
		strictEqual(resolvePackPathReference("${component:resource:evidence}", context), file);
		strictEqual(
			resolvePackPathReference("${pluginRoot}/safe dir/α 'quoted'.txt", { rootPath: root }),
			"${pluginRoot}/safe dir/α 'quoted'.txt",
			"a root without the plugin flag interprets no package reference",
		);
		for (const value of ["--file=${pluginRoot}/safe", "${pluginRoot}suffix", "${pluginRoot}/safe/${pluginRoot}"])
			throws(() => resolvePackPathReference(value, context), /complete argument/);
		for (const value of ["${pluginRoot}/safe\\..\\outside.txt", "${pluginRoot}/safe\0.txt", "${pluginRoot}/safe\n.txt"])
			throws(() => resolvePackPathReference(value, context), /unsupported/);
		symlinkSync(join(scratch, "outside.txt"), join(root, "safe", "linked file"));
		throws(() => resolvePackPathReference("${pluginRoot}/safe/linked file", context), /escaping/);
		strictEqual(resolvePackPathReference("ordinary data", context), "ordinary data");
		strictEqual(resolvePackPathReference("${pluginRoot}/safe", {}), "${pluginRoot}/safe");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});
