// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["config"],
	summary:
		"inspect effective customization; get, set or unset one setting; review or approve project safety, hooks, settings, extensions, or plugins",
	hidden: false,
});

export const leafSpecs = [
	defineCommandSpec({ path: ["config", "inspect"], summary: "print the effective-customization graph", hidden: false }),
	defineCommandSpec({
		path: ["config", "get"],
		summary: "print one setting's value and the layer it came from",
		hidden: false,
	}),
	defineCommandSpec({
		path: ["config", "set"],
		summary: "save one setting in the user or project scope",
		hidden: false,
	}),
	defineCommandSpec({
		path: ["config", "unset"],
		summary: "remove one setting from the user or project scope",
		hidden: false,
	}),
	defineCommandSpec({ path: ["config", "trust"], summary: "review or approve a project surface", hidden: false }),
] as const;

export const CONFIG_HELP = `pancode config inspect [--json]
pancode config get <path> [--scope effective|user|project] [--json]
pancode config set <path> <value> [--scope user|project] [--json]
pancode config unset <path> [--scope user|project] [--json]
pancode config trust safety|hooks|settings|extensions|plugins|handbook [--json | --hash SHA256 | --revoke]

inspect (the default) prints the effective-customization graph: what settings, context
files, rules, skills, prompts, agents, playbooks, extensions, safety, memory, hooks, and
the operator profile loaded, from where, with what precedence, trust, reload class, and
context cost. Read-only; nothing is created.

This is the "why is PanCode behaving this way" surface. Parse the --json form
in scripts instead of the table.

get, set and unset address one setting by its dotted path, such as
interface.exitSummary. See pancode config set --help for the paths it accepts.

Trust previews show the captured project files and their digest. Approve only
the reviewed digest with --hash, or remove a surface's approval with --revoke.
Settings and safety reload on restart; project hooks also check trust before execution.
Project extensions and plugins load only after their surface is approved; approve, then
reload extensions or the hub.
`;

export const CONFIG_GET_HELP = `pancode config get <path> [--scope effective|user|project] [--json]

Print one setting by its dotted path, such as interface.exitSummary.

  --scope effective   the layered value and the layer it came from (default):
                      default, user, project or project.local
  --scope user        the value saved in your user settings.yaml
  --scope project     the value saved in this project's .pancode/settings.local.yaml
                      or .pancode/settings.yaml, trusted or not
  --json              one JSON object: version, path, scope, value, source, file

A user or project scope that does not set the path exits 1 (not_found).
A path that is not a setting exits 2.
`;

export const CONFIG_SET_HELP = `pancode config set <path> <value> [--scope user|project] [--json]

Save one setting. The path is a settings control, the same ones /settings and
pancode configure --settings edit, such as interface.exitSummary. The value is
parsed by the setting's type: one of the listed choices, true or false, a number,
text, or null where the setting may be left unset. A negative number follows --,
as in: pancode config set <path> -- -1

  --scope user      your user settings.yaml (default); saved under the settings lock,
                    so a concurrent edit to another key is kept
  --scope project   this project's .pancode/settings.local.yaml; the project
                    settings must already be trusted (pancode config trust settings),
                    and the bytes written are approved
  --json            one JSON object: version, path, scope, value, file

Routing (chat.connection, chat.model, fleet.*, context.memory.connection,
context.memory.model, connections) is refused: use pancode connections use, pancode
connections profile, or pancode configure. List and structured settings are edited
with pancode configure --settings or in the settings file.

An unknown path or an invalid value exits 2 and writes nothing.
`;

export const CONFIG_UNSET_HELP = `pancode config unset <path> [--scope user|project] [--json]

Remove one setting from that scope's saved file, so the effective value falls
back to the next layer or the shipped default.

  --scope user      your user settings.yaml (default)
  --scope project   this project's .pancode/settings.local.yaml; the project
                    settings must already be trusted
  --json            one JSON object: version, path, scope, removed, file

A path the scope's file does not set exits 1 (not_found) and writes nothing.
`;
