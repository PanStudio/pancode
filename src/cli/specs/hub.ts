// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["hub"],
	summary: "register, install, update, import, inspect, and manage packs of every kind",
	hidden: false,
});

/** Every hub leaf in the order `pancode hub --help` lists them; that list, `--help --all` and `help --json` read these. */
export const leaves = [
	defineCommandSpec({
		path: ["hub", "list"],
		summary: "",
		hidden: false,
		usage: "hub list [--kind <kind>] [--user|--project] [--all] [--json]",
	}),
	defineCommandSpec({
		path: ["hub", "search"],
		summary: "",
		hidden: false,
		usage: "hub search [query] [--kind <kind>] [--all] [--json]",
	}),
	defineCommandSpec({
		path: ["hub", "components"],
		summary: "",
		hidden: false,
		usage:
			"hub components [query] [--kind skill|agent|prompt|playbook] [--source core|package|user|project|compat] [--all] [--json]",
	}),
	defineCommandSpec({
		path: ["hub", "register"],
		summary: "",
		hidden: false,
		usage: "hub register <path> [--user|--project] [--force] [--json]",
	}),
	defineCommandSpec({
		path: ["hub", "inspect"],
		summary: "",
		hidden: false,
		usage: "hub inspect <path|kind:name|name> [--user|--project] [--json]",
	}),
	defineCommandSpec({
		path: ["hub", "install"],
		summary: "",
		hidden: false,
		usage: "hub install <path|kind:name|name> [--user|--project] [--force] [--with-requirements] [--dry-run] [--json]",
	}),
	defineCommandSpec({
		path: ["hub", "import"],
		summary: "review and import a plugin package or a bare skill from a local directory or a GitHub tree URL",
		hidden: false,
		usage: "hub import <path|github-tree-url> [--user|--project] [--format claude|codex] [--dry-run] [--json] [--yes]",
	}),
	defineCommandSpec({
		path: ["hub", "update"],
		summary: "",
		hidden: false,
		usage: "hub update <kind:name|name>|--all [--user|--project] [--force] [--dry-run] [--json]",
	}),
	defineCommandSpec({
		path: ["hub", "enable"],
		summary: "",
		hidden: false,
		usage: "hub enable <kind:name|name> [--user|--project] [--dry-run] [--json]",
	}),
	defineCommandSpec({
		path: ["hub", "disable"],
		summary: "",
		hidden: false,
		usage: "hub disable <kind:name|name> [--user|--project] [--dry-run] [--json]",
	}),
	defineCommandSpec({
		path: ["hub", "remove"],
		summary: "",
		hidden: false,
		usage: "hub remove <kind:name|name> [--user|--project] [--dry-run] [--json]",
	}),
	defineCommandSpec({
		path: ["hub", "pin"],
		summary: "",
		hidden: false,
		usage: "hub pin <kind:name|name> [--user|--project] [--json]",
	}),
	defineCommandSpec({
		path: ["hub", "drift"],
		summary: "",
		hidden: false,
		usage: "hub drift [kind:name|name] [--user|--project] [--json]",
	}),
	defineCommandSpec({
		path: ["hub", "reload"],
		summary: "",
		hidden: false,
		usage: "hub reload [--json]",
	}),
	defineCommandSpec({
		path: ["hub", "skills"],
		summary: "",
		hidden: false,
		usage: "hub skills [--all] [--json]",
	}),
	defineCommandSpec({
		path: ["hub", "inventory"],
		summary: "print the model-visible skill inventory as one JSON document",
		hidden: false,
		usage: "hub inventory --json",
	}),
	defineCommandSpec({
		path: ["hub", "validate"],
		summary: "",
		hidden: false,
		usage: "hub validate <pack-path|skill-dir|SKILL.md> [--json]",
	}),
	defineCommandSpec({
		path: ["hub", "package"],
		summary: "",
		hidden: false,
		usage: "hub package <skill-dir> [--force] [--dry-run] [--json]",
	}),
	defineCommandSpec({
		path: ["hub", "sync"],
		summary: "",
		hidden: false,
		usage: "hub sync [--json]",
	}),
	defineCommandSpec({
		path: ["hub", "push"],
		summary: "",
		hidden: false,
		usage: "hub push [--json]",
	}),
	defineCommandSpec({
		path: ["hub", "remote", "confirm"],
		summary: "",
		hidden: false,
		usage: "hub remote confirm <url>",
	}),
	defineCommandSpec({
		path: ["hub", "refresh"],
		summary: "fetch the signed PanHub index and keep it only when its signatures verify",
		hidden: false,
		usage: "hub refresh [--json]",
	}),
	defineCommandSpec({
		path: ["hub", "status"],
		summary: "show the kept PanHub index, its sequences, expiry and revocations",
		hidden: false,
		usage: "hub status [--json]",
	}),
] as const;
