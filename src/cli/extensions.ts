// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { resolve } from "node:path";
import { type LoadResult, loadDomains } from "../core/domain-loader.js";
import { readLayeredSettings } from "../core/settings-layers.js";
import { approveOperatorProjectInstall, captureProjectInstallBaseline } from "../core/workspace-trust.js";
import { envelopeReviewLines, reviewExtensionEnvelope } from "../domains/extensions/envelope-review.js";
import { assignExtensionServiceModel, createExtensionHostServices } from "../domains/extensions/host-services.js";
import {
	assignExtensionModel,
	disableExtension,
	discoverExtensionPackages,
	type ExtensionDiagnostic,
	type ExtensionScope,
	enableExtension,
	type InstalledExtension,
	installExtension,
	listInstalledExtensions,
	readExtensionInstallRecord,
	removeExtension,
} from "../domains/extensions/index.js";
import { extensionInvocation } from "../domains/extensions/operator-commands.js";
import { OperatorExtensions } from "../domains/extensions/operator-extensions.js";
import type { ProvidersContract } from "../domains/providers/contract.js";
import { formatColumns, printError, printOk } from "./shared.js";

const HELP = `pancode extensions <command>

Manage PanCode extension packages.

Commands:
  pancode extensions init <id> [--template status|hook|panel|tool|workspace] [--dir <path>]
  pancode extensions validate <path> [--json]
  pancode extensions test <path>
  pancode extensions view --watch <frame-file> [--dock-taps <tap-file>]
  pancode extensions list [--all] [--json] [--user|--project]
  pancode extensions discover <path> [--json]
  pancode extensions run <id> <command> [--json] -- [arguments]
  pancode extensions install <path> [--user|--project] [--force] [--json]
  pancode extensions enable <id> [--user|--project] [--json]
  pancode extensions disable <id> [--user|--project] [--json]
  pancode extensions remove <id> [--user|--project] [--json]
  pancode extensions services <id> [--model <target>/<model> [--session-tokens <n>] | --clear] [--user|--project] [--json]

services shows or sets the model an extension's completions go to. --model records the endpoint the target
resolves to now; a call made after it changes is refused until the model is assigned again. --session-tokens
lowers the token budget the extension declared for one session.
`;

interface Parsed {
	command?: string;
	positional: string[];
	scope?: ExtensionScope;
	json: boolean;
	all: boolean;
	force: boolean;
	help: boolean;
	model?: string;
	sessionTokens?: number;
	clear: boolean;
}

function parse(argv: ReadonlyArray<string>): Parsed {
	const out: Parsed = { positional: [], json: false, all: false, force: false, help: false, clear: false };
	let argumentsOnly = false;
	let valueFor: "--model" | "--session-tokens" | undefined;
	for (const arg of argv) {
		if (valueFor === "--model") {
			out.model = arg;
			valueFor = undefined;
			continue;
		}
		if (valueFor === "--session-tokens") {
			const tokens = Number(arg);
			if (!Number.isSafeInteger(tokens) || tokens < 1) throw new Error("--session-tokens takes a positive integer");
			out.sessionTokens = tokens;
			valueFor = undefined;
			continue;
		}
		if (argumentsOnly) {
			out.positional.push(arg);
			continue;
		}
		if (arg === "--") {
			argumentsOnly = true;
			continue;
		}
		if (!out.command && !arg.startsWith("-")) {
			out.command = arg;
			continue;
		}
		switch (arg) {
			case "--json":
				out.json = true;
				break;
			case "--all":
				out.all = true;
				break;
			case "--force":
			case "-f":
				out.force = true;
				break;
			case "--user":
				if (out.scope && out.scope !== "user") throw new Error("--user and --project are mutually exclusive");
				out.scope = "user";
				break;
			case "--project":
				if (out.scope && out.scope !== "project") throw new Error("--user and --project are mutually exclusive");
				out.scope = "project";
				break;
			case "--help":
			case "-h":
				out.help = true;
				break;
			case "--model":
			case "--session-tokens":
				valueFor = arg;
				break;
			case "--clear":
				out.clear = true;
				break;
			default:
				if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
				out.positional.push(arg);
		}
	}
	if (valueFor) throw new Error(`${valueFor} needs a value`);
	return out;
}

function hasErrors(diagnostics: ReadonlyArray<ExtensionDiagnostic>): boolean {
	return diagnostics.some((diag) => diag.type === "error");
}

function printDiagnostics(diagnostics: ReadonlyArray<ExtensionDiagnostic>): void {
	for (const diag of diagnostics) {
		const detail = diag.path ? `${diag.message}: ${diag.path}` : diag.message;
		if (diag.type === "error") printError(detail);
		else process.stderr.write(`warning: ${detail}\n`);
	}
}

function toolSummary(extension: InstalledExtension): string {
	// An api-2 extension declares its tools on its runtime, not in capabilities (bt-20 papercut 3).
	const tools = [
		...(extension.capabilities?.tools.map((tool) => tool.name) ?? []),
		...(extension.runtimeV2?.tools.map((tool) => tool.name) ?? []),
	];
	return tools.length > 0 ? [...new Set(tools)].join(",") : "-";
}

function stateLabel(extension: InstalledExtension): string {
	if (!extension.valid) return "invalid";
	if (!extension.compatible) return "incompatible";
	if (!extension.enabled) return "disabled";
	if (extension.trustBlocked) return "untrusted";
	if (!extension.effective) return `shadowed:${extension.overriddenBy ?? "higher"}`;
	return extension.loadable ? "eligible" : "inactive";
}

function printList(items: ReadonlyArray<InstalledExtension>): void {
	if (items.length === 0) {
		process.stdout.write("extensions: none\n");
		return;
	}
	process.stdout.write(
		`${formatColumns([
			["id", "scope", "plugin", "state", "version", "tools", "description"],
			...items.map((extension) => [
				extension.id,
				extension.scope,
				extension.plugin ?? "-",
				stateLabel(extension),
				extension.version,
				toolSummary(extension),
				extension.description,
			]),
		])}\n`,
	);
}

export function runExtensionsCommand(argv: ReadonlyArray<string>): number | Promise<number> {
	if (argv[0] === "view") {
		return viewCommand(argv.slice(1));
	}
	if (argv[0] === "init" || argv[0] === "validate" || argv[0] === "test") return authoringCommand(argv);
	let parsed: Parsed;
	try {
		parsed = parse(argv);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}
	// A bare `pancode extensions` is a missing required argument, which the
	// exit-code contract puts at 2 with the usage on stderr. It used to print the
	// same help `--help` prints and exit 0, so a CI step gated on it went on to
	// the next line; `memory`, `evidence`, and `usage` all already answered 2
	// here.
	if (!parsed.command) {
		process.stderr.write(HELP);
		return 2;
	}
	const scopeOptions = { ...(parsed.scope ? { scope: parsed.scope } : {}) };
	switch (parsed.command) {
		case "run":
			return runOperatorCommand(parsed);
		case "services":
			return servicesCommand(parsed);
		case "list": {
			const items = listInstalledExtensions(process.cwd(), { ...scopeOptions, all: parsed.all });
			if (parsed.json) process.stdout.write(`${JSON.stringify({ extensions: items }, null, 2)}\n`);
			else {
				printList(items);
				for (const item of items) printDiagnostics(item.diagnostics);
			}
			return 0;
		}
		case "discover": {
			const root = parsed.positional[0];
			if (!root || parsed.positional.length !== 1) {
				process.stderr.write("usage: pancode extensions discover <path>\n");
				return 2;
			}
			const candidates = discoverExtensionPackages(resolve(root));
			if (parsed.json) process.stdout.write(`${JSON.stringify({ candidates }, null, 2)}\n`);
			else {
				for (const candidate of candidates) {
					const label = candidate.manifest ? `${candidate.manifest.id}@${candidate.manifest.version}` : candidate.path;
					process.stdout.write(`${candidate.valid ? "ok" : "invalid"}  ${label}  ${candidate.path}\n`);
					printDiagnostics(candidate.diagnostics);
				}
			}
			return candidates.some((candidate) => !candidate.valid) ? 1 : 0;
		}
		case "install": {
			const root = parsed.positional[0];
			if (!root || parsed.positional.length !== 1) {
				process.stderr.write("usage: pancode extensions install <path> [--user|--project] [--force]\n");
				return 2;
			}
			const baseline = parsed.scope === "project" ? captureProjectInstallBaseline(process.cwd(), "extensions") : null;
			// Read from the manifest before the commit, so the operator sees what the package may do
			// ahead of the write. A package with no api 2 runtime has no envelope to show.
			const review = (() => {
				try {
					return reviewExtensionEnvelope(resolve(root));
				} catch {
					// An unreadable manifest is reported by the install itself.
					return null;
				}
			})();
			if (review && !parsed.json) {
				process.stdout.write(`${review.id} ${review.version} would be allowed to:\n`);
				for (const line of envelopeReviewLines(review)) process.stdout.write(`  ${line}\n`);
			}
			// The install applies the envelope just shown, or none when the package declares none.
			const result = installExtension(resolve(root), {
				...scopeOptions,
				force: parsed.force,
				expectedEnvelopeDigest: review?.digest ?? null,
			});
			const approved =
				baseline !== null &&
				result.extension !== undefined &&
				result.contentDigest !== undefined &&
				approveOperatorProjectInstall(process.cwd(), baseline, [
					{ id: result.extension.id, contentDigest: result.contentDigest },
				]);
			if (parsed.json)
				process.stdout.write(
					`${JSON.stringify(review ? { ...result, envelope: review.envelope, envelopeDigest: review.digest } : result, null, 2)}\n`,
				);
			else {
				printDiagnostics(result.diagnostics);
				if (result.extension) {
					printOk(`installed ${result.extension.id} (${result.extension.scope})`);
					if (approved)
						process.stdout.write(
							"Project extensions were new or already approved here, so your install keeps them approved. Changes made outside your installs need pancode config trust extensions.\n",
						);
					else if (result.extension.scope === "project")
						process.stdout.write(
							"Project extensions are not approved for this workspace; review them with pancode config trust extensions.\n",
						);
				}
			}
			return hasErrors(result.diagnostics) ? 1 : 0;
		}
		case "enable":
		case "disable": {
			const id = parsed.positional[0];
			if (!id || parsed.positional.length !== 1) {
				process.stderr.write(`usage: pancode extensions ${parsed.command} <id> [--user|--project]\n`);
				return 2;
			}
			const result = parsed.command === "enable" ? enableExtension(id, scopeOptions) : disableExtension(id, scopeOptions);
			if (parsed.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			else {
				printDiagnostics(result.diagnostics);
				if (result.extension) printOk(`${parsed.command}d ${result.extension.id} (${result.extension.scope})`);
			}
			return hasErrors(result.diagnostics) ? 1 : 0;
		}
		case "remove": {
			const id = parsed.positional[0];
			if (!id || parsed.positional.length !== 1) {
				process.stderr.write("usage: pancode extensions remove <id> [--user|--project]\n");
				return 2;
			}
			const result = removeExtension(id, scopeOptions);
			if (parsed.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			else {
				printDiagnostics(result.diagnostics);
				if (result.removed) printOk(`removed ${result.removed.id} (${result.removed.scope})`);
			}
			return hasErrors(result.diagnostics) ? 1 : 0;
		}
		default:
			printError(`unknown extensions command: ${parsed.command}`);
			process.stderr.write(HELP);
			return 2;
	}
}

async function runOperatorCommand(parsed: Parsed): Promise<number> {
	const [id, command, ...args] = parsed.positional;
	if (!id || !command || parsed.scope || parsed.force || parsed.all || parsed.model || parsed.clear) {
		process.stderr.write("usage: pancode extensions run <id> <command> [--json] -- [arguments]\n");
		return 2;
	}
	const selected = listInstalledExtensions(process.cwd(), { all: true }).find(
		(entry) => entry.id === id && entry.loadable,
	);
	if (!selected?.runtimeV2?.commands.some((entry) => entry.name === command)) {
		printError(`extension ${id} has no eligible operator command '${command}'`);
		return 1;
	}
	const services = cliServiceDomains();
	const runtime = new OperatorExtensions({
		services: createExtensionHostServices({ providers: services.providers }),
		// The layered read keeps a broken user file from failing the command; the key is user-layer only.
		sandboxUnixSockets: () => readLayeredSettings(process.cwd()).settings.safety.sandboxUnixSockets,
		context: () => ({ workspace: process.cwd(), sessionId: null, mode: "headless" }),
		isIdle: () => true,
		onlyId: id,
	});
	const controller = new AbortController();
	const cancel = (): void => {
		controller.abort();
		void runtime.dispose();
	};
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	try {
		const reload = await runtime.reload("startup");
		if (reload.status !== "committed") throw new Error(reload.message);
		const provenance = runtime.entries().find((entry) => entry.id === id && entry.state === "ready")?.provenance;
		const output = await runtime.invoke(extensionInvocation(id, command), args.join(" "), [], controller.signal);
		if (!provenance) throw new Error("extension result has no activated provenance");
		const generation = runtime.entries().find((entry) => entry.id === id)?.generation ?? reload.generation;
		if (parsed.json)
			process.stdout.write(`${JSON.stringify({ extensionId: id, command, generation, provenance, output })}\n`);
		else process.stdout.write(`${output.text}\n`);
		return 0;
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		process.off("SIGINT", cancel);
		process.off("SIGTERM", cancel);
		await runtime.dispose();
		await services.stop();
	}
}

/** The domains a model call from a shell needs, loaded on first use: config, routes and the process journal. */
function cliServiceDomains(): { providers: () => Promise<ProvidersContract>; stop(): Promise<void> } {
	let loaded: Promise<LoadResult> | undefined;
	return {
		providers: async () => {
			loaded ??= (async () => {
				const [
					{ ConfigDomainModule },
					{ ProvidersDomainModule },
					{ SessionDomainModule },
					{ TelemetryDomainModule },
					{ ensurePancodeState },
				] = await Promise.all([
					import("../domains/config/index.js"),
					import("../domains/providers/index.js"),
					import("../domains/session/index.js"),
					import("../domains/telemetry/index.js"),
					import("../domains/lifecycle/index.js"),
				]);
				ensurePancodeState();
				return loadDomains([ConfigDomainModule, ProvidersDomainModule, SessionDomainModule, TelemetryDomainModule]);
			})();
			const providers = (await loaded).getContract("providers");
			if (!providers) throw new Error("model routes are unavailable: the providers domain did not load");
			return providers;
		},
		stop: async () => {
			if (loaded) await (await loaded).stop();
		},
	};
}

async function servicesCommand(parsed: Parsed): Promise<number> {
	const [id] = parsed.positional;
	if (
		!id ||
		parsed.positional.length !== 1 ||
		parsed.all ||
		parsed.force ||
		(parsed.clear && parsed.model !== undefined) ||
		(parsed.sessionTokens !== undefined && parsed.model === undefined)
	) {
		process.stderr.write(
			"usage: pancode extensions services <id> [--model <target>/<model> [--session-tokens <n>] | --clear] [--user|--project]\n",
		);
		return 2;
	}
	const cwd = process.cwd();
	const extension = listInstalledExtensions(cwd, { all: true }).find(
		(entry) => entry.id === id && (parsed.scope ? entry.scope === parsed.scope : entry.effective),
	);
	if (!extension || extension.scope === "dev") {
		printError(`extension ${id} is not installed${parsed.scope ? ` in ${parsed.scope} scope` : ""}`);
		return 1;
	}
	const declared = extension.runtimeV2?.services?.model;
	const location = { cwd, scope: extension.scope };
	if (parsed.model !== undefined) {
		const slash = parsed.model.indexOf("/");
		if (slash <= 0 || slash === parsed.model.length - 1) {
			printError("--model takes <target>/<model>");
			return 2;
		}
		if (!declared) {
			printError(`extension ${id} declares no runtime.services.model`);
			return 1;
		}
		const domains = cliServiceDomains();
		try {
			const result = assignExtensionServiceModel(
				await domains.providers(),
				{
					id,
					target: parsed.model.slice(0, slash),
					model: parsed.model.slice(slash + 1),
					declared: declared.sessionTokens,
					...(parsed.sessionTokens !== undefined ? { sessionTokens: parsed.sessionTokens } : {}),
				},
				location,
			);
			if (parsed.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			else {
				printDiagnostics(result.diagnostics);
				if (!hasErrors(result.diagnostics))
					printOk(
						`${id} completions go to ${parsed.model} at ${result.endpoint}, up to ${parsed.sessionTokens ?? declared.sessionTokens} tokens a session`,
					);
			}
			return hasErrors(result.diagnostics) ? 1 : 0;
		} catch (error) {
			printError(error instanceof Error ? error.message : String(error));
			return 1;
		} finally {
			await domains.stop();
		}
	}
	if (parsed.clear) {
		const result = assignExtensionModel(id, null, location);
		if (parsed.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		else {
			printDiagnostics(result.diagnostics);
			if (!hasErrors(result.diagnostics)) printOk(`${id} has no model assigned; its completions are refused`);
		}
		return hasErrors(result.diagnostics) ? 1 : 0;
	}
	const assigned = readExtensionInstallRecord(id, location)?.services?.model;
	const store = extension.runtimeV2?.services?.store;
	if (parsed.json) {
		process.stdout.write(
			`${JSON.stringify({ id, scope: extension.scope, model: declared ?? null, assigned: assigned ?? null, store: store ?? null }, null, 2)}\n`,
		);
		return 0;
	}
	process.stdout.write(
		`${[
			`embedding: ${extension.runtimeV2?.services?.embedding ? "declared" : "not declared"}`,
			declared
				? assigned
					? `model: ${assigned.target}/${assigned.model} at ${assigned.endpoint}, up to ${Math.min(declared.sessionTokens, assigned.sessionTokens ?? declared.sessionTokens)} tokens a session, ${declared.maxOutputTokens} a reply (assigned ${assigned.assignedAt})`
					: `model: none assigned, so its completions are refused; assign one with pancode extensions services ${id} --model <target>/<model>`
				: "model: not declared",
			store
				? `store: reads ${[...store.read, ...store.write].join(", ")}; writes ${store.write.join(", ") || "none"}`
				: "store: not declared",
		].join("\n")}\n`,
	);
	return 0;
}

async function viewCommand(argv: ReadonlyArray<string>): Promise<number> {
	const { runExtensionsView } = await import("./extensions-view.js");
	return runExtensionsView(argv);
}

async function authoringCommand(argv: ReadonlyArray<string>): Promise<number> {
	const { runExtensionsAuthoring } = await import("./extensions-authoring.js");
	return runExtensionsAuthoring(argv);
}
