import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initializePancodeHome } from "../../../../src/core/init.js";
import { installExtension } from "../../../../src/domains/extensions/manager.js";

const cwd = process.argv[2];
assert.ok(cwd);
initializePancodeHome();
const config = process.env.PANCODE_CONFIG_DIR;
assert.ok(config);
const prompt = join(config, "prompts");
mkdirSync(prompt, { recursive: true });
writeFileSync(
	join(prompt, "fixture-welcome.md"),
	"---\ndescription: Explain a project in plain language.\n---\nDescribe this project for someone learning to build.\n",
);
const skill = join(config, "skills", "fixture-skill");
mkdirSync(skill, { recursive: true });
writeFileSync(
	join(skill, "SKILL.md"),
	"---\nname: fixture-skill\ndescription: A small PanHub fixture.\n---\nExplain the next step.\n",
);
const source = join(cwd, "extension-source");
mkdirSync(source, { recursive: true });
writeFileSync(
	join(source, "pancode-extension.yaml"),
	JSON.stringify({
		id: "fixture-extension",
		name: "Fixture extension",
		version: "1.0.0",
		description: "Read-only discovery fixture.",
		compatibility: { pancode: ">=0.0.0" },
	}),
);
// Project copies stay unloaded until the workspace trusts them, so the loadable fixture is a user copy.
const result = installExtension(source, { cwd, scope: "user" });
assert.ok(result.extension, JSON.stringify(result.diagnostics));
mkdirSync(join(cwd, ".pancode"), { recursive: true });
writeFileSync(
	join(cwd, "package.json"),
	JSON.stringify({
		name: "hub-fixture",
		private: true,
		scripts: { test: `node -e "require('fs').writeFileSync('check-ran','yes')"` },
	}),
);
process.stdout.write(JSON.stringify({ extension: result.extension.id }));
