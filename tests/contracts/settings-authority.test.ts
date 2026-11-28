// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLayeredSettings } from "../../src/core/settings-layers.js";
import { validateSettings } from "../../src/core/settings-validate.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import {
	createSafetyPolicyEngine,
	type OperatorDefaultScope,
	type OperatorYoloScope,
} from "../../src/domains/safety/policy-engine.js";
import { loadProjectSafetyPolicy } from "../../src/domains/safety/project-policy.js";
import { invokesSettingsMutation } from "../../src/domains/safety/settings-authority.js";
import { runOperatorShellLine } from "../../src/domains/session/operator-shell.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

const OPERATOR_DEFAULT: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: false };
const OPERATOR_YOLO: OperatorYoloScope = { scratchRoots: [] };

test("PanCode's settings, credential and trust CLI is recognized however it is launched; read forms are not", () => {
	const mutating = [
		"pancode configure --id litellm --runtime litellm --url http://gw:4000 --api-key-env K --set-fleet-default 2>&1",
		"pancode configure",
		"PANCODE_CONFIG_DIR=/x PANCODE_STATE_DIR=/y pancode configure --id a --runtime openai",
		"env FOO=1 pancode connections use gw",
		"node /opt/pancode/dist/cli/index.js configure --id a --runtime openai",
		"npx -y pancode@0.7.0 auth login litellm",
		"pnpm dlx pancode connections add --id x",
		"bash -c 'pancode connections profile set fast gw --model m'",
		"echo start && pancode connections remove gw",
		"$(which pancode) configure --id x --runtime y",
		"pancode --api-key sk-test run hello",
		"pancode mcp trust docs",
		"pancode configure --json 2>&1 && pancode connections use gw >/dev/null",
		"pancode reset --settings --force",
		"pancode config set nope.key 1",
		"pancode config --scope project unset safety.scratchRoots",
		// FX-9: a body a shell reads, here or on a remote host, is still a launch.
		"ssh node <<'EOF'\npancode configure --id x\nEOF",
	];
	for (const command of mutating) strictEqual(invokesSettingsMutation(command), true, command);
	const reads = [
		"pancode configure --json",
		"pancode configure --list --all",
		"pancode configure --list 2>&1 | head -40; echo ---; pancode configure --help 2>&1 | head -60",
		"pancode configure --json >settings.json 2>/dev/null",
		"pancode configure --id x --help",
		"pancode connections --json; pancode connections fleet",
		"pancode connections profile list",
		"pancode auth status litellm",
		"pancode config inspect --json",
		"pancode config get nope.key",
		"pancode reset --all --dry-run",
		"./configure --prefix=/usr && make",
		"git config user.name x",
		"git commit -m 'pancode configure --id x'",
		// FX-9: a quoted body only a non-shell reads is that program's text.
		"python3 -B - <<'EOF'\n// run pancode configure --id x to fix the model's settings\nEOF",
	];
	for (const command of reads) strictEqual(invokesSettingsMutation(command), false, command);
});

// Baseline: a headless run shelled out to `pancode configure`, the sandbox
// refused the settings lock, and the `unsandboxed: true` rerun reached the
// safety judge, which allowed it, so settings.yaml changed with no card.
test("a settings CLI call is blocked at default, unsandboxed or not, and on the yolo floor", async (t) => {
	const home = await isolatePancodeEnv("pancode-settings-authority-");
	t.after(() => home.restore());
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pancode-settings-authority-ws-")));
	const engine = createSafetyPolicyEngine({ cwd, projectPolicy: loadProjectSafetyPolicy(cwd) });
	const command =
		"pancode configure --id litellm --runtime litellm --url http://192.0.2.1:4000 --model m --api-key-env LITELLM_API_KEY --set-fleet-default 2>&1";
	for (const unsandboxed of [false, true]) {
		const call = { tool: ToolNames.Bash, args: { command, ...(unsandboxed ? { unsandboxed: true } : {}) } };
		const atDefault = engine.evaluate(call, "default", OPERATOR_DEFAULT);
		strictEqual(atDefault.kind, "block", `default unsandboxed=${unsandboxed}`);
		strictEqual(atDefault.reasonCode, "yolo-floor:settings-authority");
		const atYolo = engine.evaluate(call, "yolo", OPERATOR_YOLO);
		strictEqual(atYolo.kind, "block", `yolo unsandboxed=${unsandboxed}`);
		strictEqual(atYolo.reasonCode, "yolo-floor:settings-authority");
	}
	const read = engine.evaluate(
		{ tool: ToolNames.Bash, args: { command: "pancode connections --json" } },
		"default",
		OPERATOR_DEFAULT,
	);
	strictEqual(read.reasonCode.endsWith("settings-authority"), false);
	// LEAD-2: a dotted settings path is no key file, though a file of that name, or a launcher from the workspace, still is.
	const bash = (command: string) => ({ tool: ToolNames.Bash, args: { command } });
	strictEqual(engine.evaluate(bash("pancode config get nope.key")).kind, "allow");
	strictEqual(engine.evaluate(bash("pancode config set nope.key 1")).reasonCode, "settings-authority");
	for (const command of ["cat nope.key", "./pancode config get nope.key", "pancode config get ../nope.key"])
		strictEqual(engine.evaluate(bash(command)).reasonCode, "secret_path_bash", command);
	// FX-7: a glob entry holds only a word in a path position or naming a file; `event.key` in a script or text is a field.
	for (const command of [
		"sed -i 's/event.key/e.code/' src/x.ts",
		"echo event.key",
		"cat > y.ts <<'EOF'\nevent.key\nEOF",
	])
		strictEqual(engine.evaluate(bash(command)).kind, "allow", command);
	// XR-43: a quoted commit message is not a file operand; real readers and unquoted substitutions still are. C-22 (row
	// 287): a quoted body `cat` or `tee` copies into a file is content too, when the parsed call runs nothing that could
	// read the copy as code; the file it writes stays judged.
	const commitMessage = "git add src/x.ts && git commit -q -F - <<'EOF'\nMention credentials.yaml\nEOF\n";
	for (const command of [
		commitMessage,
		"true <<-'EOF'\n\tcredentials.yaml\n\tEOF\n",
		"cat > notes.yaml <<'EOF'\nsecrets:\n  - credentials.yaml,\nEOF",
		"cat >> report.md <<'EOF'\nThe rail read credentials.yaml as a path.\nEOF",
		"tee report.md > /dev/null <<'EOF'\nsee nope.key\nEOF",
	]) {
		strictEqual(engine.evaluate(bash(command), "default", OPERATOR_DEFAULT).kind, "allow", command);
	}
	for (const command of [
		`${commitMessage}cat credentials.yaml`,
		"bash <<'EOF'\ncat credentials.yaml\nEOF",
		"git commit -F - <<EOF\n$(cat credentials.yaml)\nEOF",
		"cat > notes.md <<EOF\n$(cat credentials.yaml)\nEOF",
		"cat >> report.md <<'EOF'\ncat credentials.yaml\nEOF\nbash report.md",
		"cat >> report.md <<'EOF'\ncat credentials.yaml\nEOF\nnpm test",
		"cat <<'EOF' | sh\ncat credentials.yaml\nEOF",
		"cat credentials.yaml > out.txt <<'EOF'\nx\nEOF",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
		"P=PA; export \"${P}TH=/tmp/evil\"\ngit commit -F - <<'EOF'\ncat credentials.yaml >&2\nEOF",
		"cat <<$'EOF' > /dev/null\nhello\n$EOF\ncat credentials.yaml\nEOF",
		"cat 3>notes.md 1>&3 <<'EOF'\ncredentials.yaml\nEOF",
		// Neon round: a locale-quoted command name bash may translate to any program.
		"$\"cat\" <<'EOF'\nrm -rf protected.txt; cat .env\nEOF",
		// A step that opens the names a copied body holds.
		"cat <<'EOF' > f && head -c 4 f | wc --files0-from=-\n.env\nEOF",
		"cat <<'EOF' > f && head -c 4 f > f2 && wc --files0-from=f2\n.env\nEOF",
		// A `--file=-` that is another option's value, and a commit that reads its stdin as pathspecs.
		"git commit -v -m --file=- --pathspec-from-file=- <<'EOF'\n.env\nEOF",
		"git commit -m -F- --pathspec-from-file=- <<'EOF'\n.env\nEOF",
		"git commit --author=-F- --pathspec-from-file=- <<'EOF'\n.env\nEOF",
		"wc -c < nope.key",
		"if head nope.key; then :; fi",
		"od -c *.key",
		"find . -name '*.key' -exec cat {} +",
		"locate '*.key' | xargs cat",
	])
		strictEqual(engine.evaluate(bash(command)).reasonCode, "secret_path_bash", command);
});

// pc-rc2: a launch its own prefix points at a literal scratch home writes there, not into the session's settings.
test("a settings CLI call relocated to a literal scratch home is path-policy work; any other home stays on the floor", async (t) => {
	const home = await isolatePancodeEnv("pancode-settings-relocated-");
	t.after(() => home.restore());
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pancode-settings-relocated-ws-")));
	const engine = createSafetyPolicyEngine({ cwd, projectPolicy: loadProjectSafetyPolicy(cwd) });
	const dirs = (root: string) =>
		`PANCODE_CONFIG_DIR=${root}/config PANCODE_DATA_DIR=${root}/data PANCODE_STATE_DIR=${root}/state`;
	const configure = "pancode configure --id gw --runtime openai --url http://192.0.2.1:4000 --model m";
	const judge = (command: string) => {
		const call = { tool: ToolNames.Bash, args: { command } };
		return [engine.evaluate(call, "default", OPERATOR_DEFAULT), engine.evaluate(call, "yolo", OPERATOR_YOLO)];
	};
	for (const decision of judge(`${dirs(`${cwd}/scratch-home`)} ${configure}`))
		strictEqual(decision.reasonCode.endsWith("settings-authority"), false, decision.reasonCode);
	const refused = [
		configure,
		// The session's own PANCODE_CONFIG_DIR beats an assigned PANCODE_HOME in the child.
		`PANCODE_HOME=${cwd}/scratch-home ${configure}`,
		`export ${dirs(`${cwd}/scratch-home`)}; ${configure}`,
		`S=${cwd}/scratch-home; ${dirs("$S")} ${configure}`,
		`${dirs("$(mktemp -d)")} ${configure}`,
		`${dirs("scratch-home")} ${configure}`,
		`${dirs(home.dir)} ${configure}`,
		`${dirs(join(homedir(), ".pancode-scratch"))} ${configure}`,
		// An assignment whose value ends in `/pancode` is not the launcher.
		`PANCODE_HOME=$HOME/.local/share/pancode ${configure}`,
		// Nothing else on the line may run first: a link made there would move the home after it was judged.
		`ln -s ${home.dir}/config ${cwd}/scratch-home/config && ${dirs(`${cwd}/scratch-home`)} ${configure}`,
		`true; ${dirs(`${cwd}/scratch-home`)} ${configure}`,
	];
	for (const command of refused)
		for (const decision of judge(command)) strictEqual(decision.reasonCode, "yolo-floor:settings-authority", command);
});

// The floor binds model tool calls only: the operator's own `!` line is theirs to run.
test("the operator's shell line runs PanCode's settings CLI unblocked", async (t) => {
	const home = await isolatePancodeEnv("pancode-settings-authority-operator-");
	const bin = join(home.dir, "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "pancode"), '#!/bin/sh\necho "operator ran: $*"\n');
	chmodSync(join(bin, "pancode"), 0o755);
	t.after(() => home.restore());
	const command = `${join(bin, "pancode")} configure --id gw --runtime litellm --set-fleet-default`;
	strictEqual(invokesSettingsMutation(command), true);
	const run = await runOperatorShellLine({
		command,
		cwd: home.dir,
		excludeFromContext: true,
		parentTurnId: null,
		signal: new AbortController().signal,
	});
	strictEqual(run.result.exitCode, 0);
	match(run.entry.output, /operator ran: configure --id gw --runtime litellm --set-fleet-default/);
});

// Constructed settings files: a store.projectId in the user file, the private local file and, invalid, the tracked file.
test("store.projectId is the tracked project file's alone: the user and local files are refused and an invalid id is an issue", async (t) => {
	const home = await isolatePancodeEnv("pancode-store-project-id-authority-");
	t.after(() => home.restore());
	const workspace = join(home.dir, "workspace");
	const projectDir = join(workspace, ".pancode");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(join(home.dir, "config"), { recursive: true });
	const trust = () => {
		const snapshot = captureProjectSurface(workspace, "settings");
		if (!snapshot.contentHash) throw new Error("missing project settings hash");
		recordProjectSurfaceTrust(workspace, "settings", snapshot.contentHash);
	};
	writeFileSync(join(home.dir, "config", "settings.yaml"), "version: 2\nstore:\n  projectId: from-user\n");
	writeFileSync(join(projectDir, "settings.yaml"), "store:\n  projectId: tracked-id\n");
	writeFileSync(join(projectDir, "settings.local.yaml"), "store:\n  projectId: from-local\n");
	trust();
	const layered = readLayeredSettings(workspace);
	strictEqual(layered.settings.store.projectId, "tracked-id");
	strictEqual(layered.sources["store.projectId"], "project");
	for (const origin of ["user", "project.local"]) {
		const issue = layered.issues.find((item) => item.origin === origin && item.path === "store.projectId");
		match(issue?.message ?? "", /set only in the project's tracked \.pancode\/settings\.yaml/u, origin);
	}
	writeFileSync(join(home.dir, "config", "settings.yaml"), "version: 2\n");
	writeFileSync(join(projectDir, "settings.local.yaml"), "");
	writeFileSync(join(projectDir, "settings.yaml"), "store:\n  projectId: Not_Valid\n");
	trust();
	const invalid = readLayeredSettings(workspace);
	strictEqual(invalid.settings.store.projectId, undefined);
	deepStrictEqual(
		invalid.issues.filter((item) => item.path === "store.projectId").map((item) => item.origin),
		["project"],
	);
});

test("fleet.nodes[].allowUnsandboxed is set only in user settings; project layers are stripped", async (t) => {
	const home = await isolatePancodeEnv("pancode-fleet-allow-unsandboxed-authority-");
	t.after(() => home.restore());
	const workspace = join(home.dir, "workspace");
	const projectDir = join(workspace, ".pancode");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(join(home.dir, "config", "settings.yaml"), "version: 2\n");
	writeFileSync(
		join(projectDir, "settings.yaml"),
		"fleet:\n  nodes:\n    - id: gpu\n      host: gpu.invalid\n      allowUnsandboxed: true\n",
	);
	const snapshot = captureProjectSurface(workspace, "settings");
	if (!snapshot.contentHash) throw new Error("missing project settings hash");
	recordProjectSurfaceTrust(workspace, "settings", snapshot.contentHash);
	const layered = readLayeredSettings(workspace);
	strictEqual(layered.settings.fleet.nodes[0]?.id, "gpu");
	strictEqual(layered.settings.fleet.nodes[0]?.allowUnsandboxed, undefined);
	const issue = layered.issues.find(
		(item) => item.origin === "project" && item.path === "fleet.nodes[0].allowUnsandboxed",
	);
	match(issue?.message ?? "", /allowUnsandboxed is set only in user settings/u);
});

test("safety.resources takes positive bounded integers or null, and a project may only set or lower a ceiling", async (t) => {
	const parsed = validateSettings({
		version: 2,
		safety: { resources: { main: { memoryMiB: 0, tasks: null, cpuPercent: 100001, disk: 5 }, workers: { tasks: 64 } } },
	});
	deepStrictEqual(
		parsed.issues.map((issue) => issue.path),
		["safety.resources.main.disk", "safety.resources.main.memoryMiB", "safety.resources.main.cpuPercent"],
	);
	deepStrictEqual(parsed.settings.safety.resources.workers, { memoryMiB: null, tasks: 64, cpuPercent: null });

	const home = await isolatePancodeEnv("pancode-resource-ceiling-authority-");
	t.after(() => home.restore());
	const workspace = join(home.dir, "workspace");
	const projectDir = join(workspace, ".pancode");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(
		join(home.dir, "config", "settings.yaml"),
		"version: 2\nsafety:\n  resources:\n    main:\n      memoryMiB: 1024\n      cpuPercent: 200\n",
	);
	writeFileSync(
		join(projectDir, "settings.yaml"),
		"safety:\n  resources:\n    main:\n      memoryMiB: 2048\n      tasks: 64\n      cpuPercent: null\n    workers:\n      memoryMiB: 512\n",
	);
	const snapshot = captureProjectSurface(workspace, "settings");
	if (!snapshot.contentHash) throw new Error("missing project settings hash");
	recordProjectSurfaceTrust(workspace, "settings", snapshot.contentHash);
	const layered = readLayeredSettings(workspace);
	deepStrictEqual(layered.settings.safety.resources, {
		main: { memoryMiB: 1024, tasks: 64, cpuPercent: 200 },
		workers: { memoryMiB: 512, tasks: null, cpuPercent: null },
	});
	deepStrictEqual(
		layered.issues.filter((item) => item.origin === "project").map((item) => item.path),
		["safety.resources.main.memoryMiB", "safety.resources.main.cpuPercent"],
	);

	// A project cannot clear operator ceilings with null maps or invalid floats that would fail schema validation.
	for (const bypass of [
		"safety:\n  resources: null\n",
		"safety:\n  resources:\n    main: null\n    workers: null\n",
		"safety:\n  resources:\n    main:\n      memoryMiB: 1.5\n      tasks: 0.5\n",
	]) {
		writeFileSync(join(workspace, ".pancode", "settings.yaml"), bypass);
		const snap = captureProjectSurface(workspace, "settings");
		if (!snap.contentHash) throw new Error("missing project settings hash");
		recordProjectSurfaceTrust(workspace, "settings", snap.contentHash);
		const result = readLayeredSettings(workspace);
		deepStrictEqual(result.settings.safety.resources, {
			main: { memoryMiB: 1024, tasks: null, cpuPercent: 200 },
			workers: { memoryMiB: null, tasks: null, cpuPercent: null },
		});
		strictEqual(
			result.issues.some((item) => item.origin === "project" && item.path.startsWith("safety.resources")),
			true,
		);
	}
});
