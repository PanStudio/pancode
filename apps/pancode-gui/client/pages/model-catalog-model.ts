// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// The settings page's model catalog note. Apart from model-picker-model.ts, which the task view loads with the picker.
import type { Operation } from "../../contracts/operations.js";
import { ACP_TARGET_MODEL_LIMIT } from "../../contracts/runtime.js";
import { formatTime } from "../api/clock.js";

/** A model setting's catalog: the paired target's models as PanCode last read them, and where from. */
export interface ModelCatalogView {
	readonly models: readonly string[] | null;
	readonly defaultModel: string | null;
	readonly note: string;
	/** Set when the engine lists the target, so its models can be asked for again. */
	readonly check: { readonly targetId: string; readonly checking: boolean } | null;
}

interface CatalogTarget {
	readonly id: string;
	readonly models: readonly string[];
	readonly defaultModel: string | null;
	readonly modelsTruncated: boolean;
}

const noCatalog = (note: string): ModelCatalogView => ({ models: null, defaultModel: null, note, check: null });

export function modelCatalogView(input: {
	/** The saved or drafted target; empty when the target setting is automatic. */
	readonly targetId: string;
	readonly targetLabel: string;
	readonly inventory: {
		readonly pending: boolean;
		readonly targets: readonly CatalogTarget[] | null;
		readonly error: string | null;
	};
	/** The last "Check again", only when it asked this target. */
	readonly check: { readonly starting: boolean; readonly operation: Operation | undefined } | null;
}): ModelCatalogView {
	const { targetId, inventory, check } = input;
	if (targetId === "")
		return noCatalog(`${input.targetLabel} is automatic, so type an exact model id or choose a connection first.`);
	if (inventory.pending) return noCatalog(`Reading ${targetId}'s models…`);
	if (!inventory.targets)
		return noCatalog(`The connection list could not be read${inventory.error !== null ? `: ${inventory.error}` : "."}`);
	const target = inventory.targets.find((row) => row.id === targetId);
	// The setting saved a connection the running engine does not list; that is what fails, not the choice itself.
	if (!target)
		return noCatalog(
			`PanCode's engine does not list ${targetId} among its connections, so its models cannot be shown here and new tasks cannot start on it. Repair or add it in Connections.`,
		);
	const checked = check?.operation;
	const checking = !!check && (check.starting || checked?.status === "queued" || checked?.status === "running");
	const source = checking
		? `Asking ${targetId} for its models…`
		: checked?.status === "succeeded"
			? `${targetId} answered at ${formatTime(checked.finishedAt)}: ${target.models.length} ${target.models.length === 1 ? "model" : "models"}.`
			: checked?.status === "failed"
				? `The check did not finish: ${checked.problem.detail} These are the models PanCode last read from ${targetId}.`
				: `The models PanCode last read from ${targetId}.`;
	return {
		models: target.models.length > 0 ? target.models : target.defaultModel ? [target.defaultModel] : null,
		defaultModel: target.defaultModel,
		note: target.modelsTruncated
			? `${source} The list shows the first ${ACP_TARGET_MODEL_LIMIT}; choose Advanced: unverified model id for one not shown.`
			: source,
		check: { targetId, checking },
	};
}
