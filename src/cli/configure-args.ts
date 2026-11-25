// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { CopilotContextTier, TargetDescriptor } from "../domains/providers/types/target-descriptor.js";

export const HELP = `pancode configure

Configure model targets and runtime settings for chat and fleet dispatch.

Usage:
  pancode configure                   guided setup, endpoint shortcut, or settings
  pancode configure --quick           connect an endpoint with recommended defaults
  pancode configure --settings        open the complete settings menu
  pancode configure --section <area>  open one settings area directly:
                                         models, chat, workers, context, safety,
                                         workspace, advanced
                                         Without a terminal this prints the
                                         area's values and exits.
  pancode configure --json            emit your user settings document as JSON (config inspect --json is the effective view)
  pancode configure --edit            edit all user settings in VISUAL/EDITOR;
                                         validate and review before saving
  pancode configure --interop         review detected coding agents as delegation peers
  pancode configure --import <path|https-url> [--yes] [--replace]
                                         add the targets a lab or site setup file
                                         names; shows each address and asks once
  pancode configure --list            list target runtimes (user-facing only)
  pancode configure --list --all      list every registered runtime including aliases
  pancode configure --id <targetId> [flags] --runtime <runtimeId>
  pancode configure --help, -h        show this message

In the interactive menus: arrow keys move, enter opens, escape goes back, q
quits. Where the terminal cannot support that, the same menus are numbered and
answered by typing a number, b for back, or q to quit.

Non-interactive flags:
  --id <targetId>                  target id to register (required when non-interactive)
  --runtime <runtimeId>            runtime to use when registering non-interactively
  --url <url>                      target base URL (http(s):// or ws://)
  --model <wireModelId>            default model id for this target
  --orchestrator-model <id>        model to use when setting chat default
  --background-model <id>          model to use for proactive task memory
  --fleet-model <id>               model to use when setting fleet default
                                   (mutually exclusive with --agent-profile)
  --agent-profile <name>           save this target as a named fleet profile
  --agent-profile-model <id>       model to use for --agent-profile
  --bind-agent <agentId>           bind this --agent-profile to an agent
  --api-key-env <VAR>              read API key from this env var at call time
  --api-key <literal>              store API key in credentials.yaml
  --force                          save a model outside the runtime catalog, or one the
                                   target does not advertise, without refusing
  --gateway                        mark the target as a gateway
  --lifecycle <user-managed|pancode-managed>
                                   resident model lifecycle policy
  --set-orchestrator               use this target for chat
  --verify                         with --id: send one short test request first; save only if it answers
  --no-verify                      guided setup saves without sending its test request
  --set-background                 use this target for proactive task memory
  --set-fleet-default              use this target for the fleet default
  --context-window <N>             capability override
  --max-tokens <N>                 output token capability override
  --reasoning <true|false>         capability override
  --context-tier <default|long_context>
                                   copilot-sdk only: long_context asks Copilot for the model's
                                   long-context prompt budget and prices; default clears it
`;

export interface ParsedArgs {
	positional: string[];
	help: boolean;
	list: boolean;
	all: boolean;
	interop: boolean;
	import?: string;
	yes: boolean;
	replace: boolean;
	json: boolean;
	edit: boolean;
	quick: boolean;
	settings: boolean;
	section?: string;
	id?: string;
	runtime?: string;
	url?: string;
	model?: string;
	orchestratorModel?: string;
	backgroundModel?: string;
	workerModel?: string;
	workerProfile?: string;
	workerProfileModel?: string;
	bindAgent?: string;
	apiKeyEnv?: string;
	apiKey?: string;
	force: boolean;
	gateway: boolean;
	lifecycle?: TargetDescriptor["lifecycle"];
	setOrchestrator: boolean;
	setBackground: boolean;
	setWorkerDefault: boolean;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	/** `--context-tier`: copilot-sdk only; `default` clears an existing opt-in. */
	contextTier?: CopilotContextTier;
	/** `--verify` true, `--no-verify` false, absent leaves each path's default. */
	verify?: boolean;
}

export function parseSetupArgs(argv: ReadonlyArray<string>): ParsedArgs {
	const out: ParsedArgs = {
		positional: [],
		help: false,
		list: false,
		all: false,
		interop: false,
		yes: false,
		replace: false,
		json: false,
		edit: false,
		quick: false,
		settings: false,
		force: false,
		gateway: false,
		setOrchestrator: false,
		setBackground: false,
		setWorkerDefault: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		const need = (): string => {
			const v = argv[i + 1];
			if (v === undefined) throw new Error(`${a} requires a value`);
			i += 1;
			return v;
		};
		switch (a) {
			case "--help":
			case "-h":
				out.help = true;
				break;
			case "--json":
				out.json = true;
				break;
			case "--edit":
				out.edit = true;
				break;
			case "--quick":
				out.quick = true;
				break;
			case "--settings":
				out.settings = true;
				break;
			case "--section":
				out.section = need();
				break;
			case "--list":
				out.list = true;
				break;
			case "--all":
				out.all = true;
				break;
			case "--interop":
				out.interop = true;
				break;
			case "--import":
				out.import = need();
				break;
			case "--yes":
				out.yes = true;
				break;
			case "--replace":
				out.replace = true;
				break;
			case "--id":
				out.id = need();
				break;
			case "--runtime":
				out.runtime = need();
				break;
			case "--url":
				out.url = need();
				break;
			case "--model":
				out.model = need();
				break;
			case "--orchestrator-model":
				out.orchestratorModel = need();
				break;
			case "--background-model":
				out.backgroundModel = need();
				break;
			case "--fleet-model":
				out.workerModel = need();
				break;
			case "--agent-profile":
				out.workerProfile = need();
				break;
			case "--agent-profile-model":
				out.workerProfileModel = need();
				break;
			case "--bind-agent":
				out.bindAgent = need();
				break;
			case "--api-key-env":
				out.apiKeyEnv = need();
				break;
			case "--api-key":
				out.apiKey = need();
				break;
			case "--force":
				out.force = true;
				break;
			case "--gateway":
				out.gateway = true;
				break;
			case "--lifecycle": {
				const v = need();
				if (v !== "user-managed" && v !== "pancode-managed") {
					throw new Error("--lifecycle must be user-managed or pancode-managed");
				}
				out.lifecycle = v;
				break;
			}
			case "--set-orchestrator":
				out.setOrchestrator = true;
				break;
			case "--verify":
				out.verify = true;
				break;
			case "--no-verify":
				out.verify = false;
				break;
			case "--set-background":
				out.setBackground = true;
				break;
			case "--set-fleet-default":
				out.setWorkerDefault = true;
				break;
			case "--context-window": {
				const n = Number(need());
				if (!Number.isFinite(n) || n <= 0) throw new Error("--context-window must be a positive number");
				out.contextWindow = Math.floor(n);
				break;
			}
			case "--max-tokens": {
				const n = Number(need());
				if (!Number.isFinite(n) || n <= 0) throw new Error("--max-tokens must be a positive number");
				out.maxTokens = Math.floor(n);
				break;
			}
			case "--reasoning": {
				const v = need().toLowerCase();
				if (v !== "true" && v !== "false") throw new Error("--reasoning must be true or false");
				out.reasoning = v === "true";
				break;
			}
			case "--context-tier": {
				const v = need();
				if (v !== "default" && v !== "long_context") throw new Error("--context-tier must be default or long_context");
				out.contextTier = v;
				break;
			}
			default:
				if (a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
				out.positional.push(a);
		}
	}
	return out;
}

/** A `ParsedArgs` with nothing set, for the target wizard called from a section. */
export function emptyArgs(): ParsedArgs {
	return {
		positional: [],
		help: false,
		list: false,
		all: false,
		interop: false,
		yes: false,
		replace: false,
		json: false,
		edit: false,
		quick: false,
		settings: false,
		force: false,
		gateway: false,
		setOrchestrator: false,
		setBackground: false,
		setWorkerDefault: false,
	};
}
