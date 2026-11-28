// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { accessSync, constants } from "node:fs";
import { readSettings } from "../core/config.js";
import { resolvePancodeDirs } from "../core/xdg.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import { detectMux, MUX_METHOD_MIN_PROTOCOL, resolveSocketCandidates } from "../domains/mux/index.js";
import { isPancodeHostSocket } from "../domains/mux/workspace/platform.js";
import { telemetryRunsDirectory } from "../domains/telemetry/index.js";
import { findPinnedTool, toolStatus } from "../lib/programs/index.js";
import { paneHostFinding } from "./doctor-toolchain.js";
import { workspaceEligibility } from "./workspace-launch.js";

/**
 * The panes section of `pancode doctor`.
 *
 * Six rows, in the order an operator debugs them: what mode the pane layer
 * resolved to, whether the socket answered, whether the server is new enough
 * for the notification and pane-control methods, where the pane host binary resolves, what the
 * boot layout composes, and whether the journal directory the viewer reads is
 * writable.
 *
 * No row is an error. Panes are optional: an operator who never wanted them has
 * a healthy install without them, and doctor's exit code answers "is this
 * install healthy". The rows that would be errors elsewhere are warnings that
 * name the next step instead.
 */

const PANE_HOST_TOOL_ID = "herdr";

/** Highest protocol any method PanCode drives requires, for the version row. */
const REQUIRED_PROTOCOL = Math.max(...Object.values(MUX_METHOD_MIN_PROTOCOL));

function journalWritabilityFinding(root = telemetryRunsDirectory(resolvePancodeDirs().state)): DoctorFinding {
	try {
		accessSync(root, constants.W_OK);
		return { ok: true, name: "panes journal dir", detail: `${root} is writable` };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ok: true, name: "panes journal dir", detail: `${root} has no run journal yet` };
		}
		return {
			ok: true,
			level: "warn",
			name: "panes journal dir",
			detail: `${root} is absent or not writable (${error instanceof Error ? error.message : String(error)}); \`pancode fleet view\` will have no transcript to follow`,
		};
	}
}

/**
 * The `panes mode` row: what a bare `pancode` started from this
 * environment would do. It asks the launcher's own eligibility rule
 * (workspace-launch.ts) rather than guest detection, because inside the
 * operator's own herdr a bare launch opens PanCode's private host nested in the
 * pane and only `--with-panes` joins that herdr as a guest. Doctor may itself
 * be piped (`--json`), so the rule is asked about a launch from a terminal.
 * `guest` is the detection the boot would get when it stays in a herdr pane,
 * and is null outside one.
 */
export function panesModeFinding(
	env: NodeJS.ProcessEnv,
	guest: { mode: string; reason: string } | null,
): DoctorFinding {
	const name = "panes mode";
	const eligibility = workspaceEligibility({
		options: {},
		env,
		stdinIsTTY: true,
		stdoutIsTTY: true,
		insidePancodeHost: isPancodeHostSocket(env.HERDR_SOCKET_PATH),
	});
	if (eligibility.kind === "open" && !eligibility.nested) {
		return {
			ok: true,
			name,
			detail: "PanCode's private pane host opens with bare `pancode`; this command is not running inside one",
		};
	}
	if (eligibility.kind === "open") {
		// A guest reason already opens with its mode (`guest on <socket>, herdr <version>, protocol <n>`).
		const join =
			guest === null
				? ""
				: ` (${guest.reason.startsWith(`${guest.mode} `) ? guest.reason : `${guest.mode}; ${guest.reason}`})`;
		return {
			ok: true,
			level: "ok",
			name,
			detail: `nested; bare \`pancode\` opens PanCode's private pane host inside this herdr pane with the prefix ctrl+shift+b; \`pancode --with-panes\` joins this herdr as a guest instead${join}`,
		};
	}
	if (guest === null) {
		return { ok: true, name, detail: `plain; bare \`pancode\` stays in this terminal (${eligibility.reason})` };
	}
	// A boot that stays in a herdr pane detects that host and joins it as a guest.
	return {
		ok: true,
		level: guest.mode === "none" ? "warn" : "ok",
		name,
		detail: `${guest.mode}; bare \`pancode\` stays in this pane (${eligibility.reason}) and joins its host: ${guest.reason}`,
	};
}

export async function panesFindings(env: NodeJS.ProcessEnv = process.env): Promise<DoctorFinding[]> {
	let layoutRow: DoctorFinding = {
		ok: true,
		name: "panes layout",
		detail: "off",
	};
	try {
		const panes = readSettings().interface.panes;
		if (panes.layout !== "off") {
			layoutRow = {
				ok: true,
				name: "panes layout",
				detail: `${panes.layout} at boot (workers dock ${(panes.workers.ratio * 100).toFixed(0)}%, files dock ${(panes.files.ratio * 100).toFixed(0)}%)`,
			};
		}
	} catch {
		// An unreadable settings file is already reported by the settings row;
		// this section answers on the shipped default (off) rather than throwing.
	}

	// Outside a pane host is the ordinary state of a machine where PanCode hosts
	// its own: bare `pancode` opens its private host, and a command like this
	// one, run from a plain terminal, is simply not in it. There is no socket to
	// expect, so probing for one and warning about its absence would put three
	// warnings on every healthy install.
	if (env.HERDR_ENV !== "1") return [panesModeFinding(env, null), layoutRow];

	// Detection is the same ladder the interactive boot runs, so this row is the
	// answer that boot would get. It opens a socket and nothing else: no file is
	// created and no pane is touched.
	const { detection, client } = await detectMux({ enabled: "auto", env });
	await client?.close().catch(() => undefined);

	const candidates = detection.candidates.length > 0 ? detection.candidates : resolveSocketCandidates(env);
	const findings: DoctorFinding[] = [
		panesModeFinding(env, detection),
		{
			ok: true,
			level: detection.socketPath === null ? "warn" : "ok",
			name: "panes socket",
			detail:
				detection.socketPath === null
					? `no socket answered; tried ${candidates.length > 0 ? candidates.join(", ") : "no candidates"}`
					: `${detection.socketPath} answered a ping`,
		},
	];

	const server = detection.server;
	findings.push({
		ok: true,
		level: server === null || server.protocol < REQUIRED_PROTOCOL ? "warn" : "ok",
		name: "panes protocol",
		detail:
			server === null
				? `unknown; PanCode's optional methods need protocol ${REQUIRED_PROTOCOL} or newer`
				: `server ${server.version}, protocol ${server.protocol}; PanCode's optional methods need ${REQUIRED_PROTOCOL} (${server.protocol >= REQUIRED_PROTOCOL ? "satisfied" : "toasts and agent focus fall back"})`,
	});

	const entry = findPinnedTool(PANE_HOST_TOOL_ID);
	findings.push(
		entry === null
			? {
					ok: true,
					level: "warn",
					name: "panes binary",
					detail: `${PANE_HOST_TOOL_ID} is not in the pinned tool registry`,
				}
			: samePaneHostRow(paneHostFinding(toolStatus(entry), "panes binary")),
	);

	findings.push(layoutRow);
	findings.push(journalWritabilityFinding());
	return findings;
}

/** The toolchain section reports the same missing pin; a warning points at that row rather than reading as a second problem. */
function samePaneHostRow(finding: DoctorFinding): DoctorFinding {
	return finding.level === "warn"
		? { ...finding, detail: `${finding.detail} (same as \`external tool herdr\`)` }
		: finding;
}
