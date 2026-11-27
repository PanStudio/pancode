// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { elicitationValueError } from "../../../../src/core/views/elicitation-values.js";
import type { ElicitationField, ElicitationValue } from "../../contracts/elicitation.js";

/** What the operator has put in one field: typed text, a yes/no, one choice or several. null is left unset. */
export type ElicitationDraft = Record<string, string | boolean | string[] | null>;

export function blankElicitation(fields: readonly ElicitationField[]): ElicitationDraft {
	const draft: ElicitationDraft = {};
	for (const field of fields) {
		if (field.kind === "string") draft[field.key] = field.default ?? "";
		else if (field.kind === "number") draft[field.key] = field.default === undefined ? "" : String(field.default);
		else if (field.kind === "multi") draft[field.key] = field.default ?? [];
		else draft[field.key] = field.default ?? null;
	}
	return draft;
}

function fieldValue(field: ElicitationField, draft: ElicitationDraft[string] | undefined): ElicitationValue | null {
	if (draft === undefined || draft === null) return null;
	switch (field.kind) {
		case "string":
			return typeof draft === "string" && draft !== "" ? draft : null;
		case "number": {
			const text = typeof draft === "string" ? draft.trim() : "";
			return text === "" ? null : Number(text);
		}
		case "multi":
			return Array.isArray(draft) && (draft.length > 0 || field.required) ? draft : null;
		default:
			return typeof draft === "string" || typeof draft === "boolean" ? draft : null;
	}
}

/**
 * The form's content as it would be sent, and each field's reason it cannot
 * be yet. An empty optional field is left out, as MCP asks.
 */
export function elicitationContent(
	fields: readonly ElicitationField[],
	draft: ElicitationDraft,
): { content: Record<string, ElicitationValue>; errors: Record<string, string> } {
	const content: Record<string, ElicitationValue> = {};
	const errors: Record<string, string> = {};
	for (const field of fields) {
		const value = fieldValue(field, draft[field.key]);
		if (value === null) {
			if (field.required) errors[field.key] = "is required";
			continue;
		}
		const error = elicitationValueError(field, value);
		if (error !== null) errors[field.key] = error;
		else content[field.key] = value;
	}
	return { content, errors };
}

/** How one value reads on the review page. */
export function describeElicitationValue(field: ElicitationField, value: ElicitationValue | undefined): string {
	if (value === undefined) return "Left unset";
	if (field.kind === "boolean") return value === true ? "Yes" : "No";
	const label = (option: string) =>
		field.kind === "choice" || field.kind === "multi"
			? (field.options.find((entry) => entry.value === option)?.label ?? option)
			: option;
	if (Array.isArray(value)) return value.length === 0 ? "None selected" : value.map(label).join(", ");
	return label(String(value));
}
