// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { Operation } from "../../contracts/operations.js";
import type { CliTargets } from "../../contracts/targets-cli.js";
import { terminalOperation } from "../api/operation-request-model.js";
import type { StatusTone } from "../design/status.js";

type CliTarget = CliTargets["targets"][number];

const ACTION_TITLE: Readonly<Record<string, string>> = {
	"targets.probe": "Connection check",
	"targets.use": "Use for chat & fleet",
	"targets.remove": "Remove connection",
	"targets.signout": "Sign out",
};

const STATUS_WORD: Readonly<Record<Operation["status"], string>> = {
	queued: "queued",
	running: "running",
	succeeded: "done",
	failed: "failed",
	cancelled: "canceled",
};

/**
 * The connection operation panel. A probe that ran to the end "succeeded" as an operation whatever it
 * found, so its heading carries what it found instead; and the running notes go once the operation
 * is over, so a settled check never still says it is probing.
 */
export function connectionOperationView(operation: Operation): { heading: string; progress: Operation["progress"] } {
	const title = ACTION_TITLE[operation.kind] ?? operation.kind.replace("targets.", "Connection ");
	let outcome = STATUS_WORD[operation.status];
	if (operation.kind === "targets.probe" && operation.status === "succeeded" && "targets" in operation.result) {
		const { id, probe } = operation.result;
		const target = operation.result.targets.targets.find((row) => row.id === id);
		outcome =
			probe?.reason === "component-missing"
				? "component not installed"
				: target === undefined || target.health === "unknown"
					? "reachability unknown"
					: target.available && (target.health === "healthy" || target.health === "degraded")
						? "reachable"
						: "not reachable";
	}
	return {
		heading: `${title} · ${outcome}`,
		progress: terminalOperation(operation) ? [] : operation.progress,
	};
}

/** A connection's availability mark; an unknown health says so rather than guessing from the flag. */
export function targetAvailability(target: Pick<CliTarget, "health" | "available">): {
	tone: StatusTone;
	label: string;
} {
	if (target.health === "unknown") return { tone: "unverified", label: "Availability unknown" };
	return target.available ? { tone: "success", label: "Available" } : { tone: "warn", label: "Unavailable" };
}

export function targetEndpoint(target: Pick<CliTarget, "url" | "builtIn">): string {
	return target.url ?? (target.builtIn ? "Built-in endpoint" : "Endpoint not reported");
}
