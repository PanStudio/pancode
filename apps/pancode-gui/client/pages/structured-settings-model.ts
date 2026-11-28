// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// The structured collection editor's rows. Apart from settings-control-model.ts, which the task view's budget banner
// loads, so the structured-settings table ships only with the settings page.
import {
	STRUCTURED_SETTINGS,
	type StructuredField,
	type StructuredSettingEditor,
} from "../../contracts/structured-settings.js";

/** One entry of a structured collection; `id` only keys the editor's rows and never reaches the saved value. */
export type StructuredRow = { id: string; name: string; values: Record<string, unknown>; members?: StructuredRow[] };

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The editor's rows for a saved collection; unreadable JSON opens as an empty collection. */
export function structuredRows(path: string, value: string, newId: () => string): StructuredRow[] {
	try {
		const editor = STRUCTURED_SETTINGS[path];
		if (!editor) return [];
		const data: unknown = JSON.parse(value);
		const row = (value: unknown, name = ""): StructuredRow => ({ id: newId(), name, values: record(value) });
		if (editor.kind === "list") return Array.isArray(data) ? data.map((item) => row(item)) : [];
		return Object.entries(record(data)).map(([name, item]) =>
			editor.kind === "values"
				? row({ value: item }, name)
				: editor.kind === "rosters"
					? {
							...row({}, name),
							members: Array.isArray(record(item).members)
								? (record(item).members as unknown[]).map((member) => row(member))
								: [],
						}
					: row(item, name),
		);
	} catch {
		return [];
	}
}

/** The collection as the setting saves it; empty fields are left out so the engine applies its defaults. */
export function structuredJson(kind: StructuredSettingEditor["kind"], rows: readonly StructuredRow[]): string {
	const clean = (values: Record<string, unknown>) =>
		Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "" && value !== undefined));
	return JSON.stringify(
		kind === "list"
			? rows.map((row) => clean(row.values))
			: Object.fromEntries(
					rows.map((row) => [
						row.name.trim(),
						kind === "values"
							? (row.values.value ?? "")
							: kind === "rosters"
								? { members: row.members?.map((member) => clean(member.values)) ?? [] }
								: clean(row.values),
					]),
				),
	);
}

export const structuredFieldText = (raw: unknown): string =>
	Array.isArray(raw) ? raw.join(", ") : raw === undefined || raw === null ? "" : String(raw);

/** The runtime value a field's typed text stands for. */
export function structuredFieldValue(kind: StructuredField["kind"], input: string): unknown {
	if (kind === "number" && input !== "") return Number(input);
	if (kind === "list")
		return input
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);
	return input;
}

/** The first `new-<entry>-N` name no entry uses yet. */
export function newEntryName(entryName: string, names: readonly string[]): string {
	const prefix = `new-${entryName.toLowerCase().replaceAll(" ", "-")}-`;
	let number = 1;
	while (names.includes(`${prefix}${number}`)) number++;
	return `${prefix}${number}`;
}
