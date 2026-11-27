// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Kept free of typebox values so the browser bundle can check a form without the schema library.
import type { ElicitationField } from "./elicitation.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/u;

function validDate(text: string): boolean {
	const match = DATE.exec(text);
	if (!match) return false;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function formatError(format: "email" | "uri" | "date" | "date-time", text: string): string | null {
	if (format === "email") return EMAIL.test(text) ? null : "must be an email address";
	if (format === "date") return validDate(text) ? null : "must be a date like 2026-07-28";
	if (format === "date-time")
		return DATE_TIME.test(text) && validDate(text.slice(0, 10))
			? null
			: "must be a date and time like 2026-07-28T09:30:00Z";
	try {
		new URL(text);
		return null;
	} catch {
		return "must be an absolute URI";
	}
}

/** Why a value does not fit its field, or null. The runtime checks again before anything reaches the server. */
export function elicitationValueError(field: ElicitationField, value: unknown): string | null {
	switch (field.kind) {
		case "string": {
			if (typeof value !== "string") return "must be text";
			const length = Array.from(value).length;
			if (field.minLength !== undefined && length < field.minLength)
				return `must be at least ${field.minLength} characters`;
			if (field.maxLength !== undefined && length > field.maxLength)
				return `must be at most ${field.maxLength} characters`;
			return field.format === undefined ? null : formatError(field.format, value);
		}
		case "number":
			if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
			if (field.integer && !Number.isInteger(value)) return "must be a whole number";
			if (field.minimum !== undefined && value < field.minimum) return `must be at least ${field.minimum}`;
			if (field.maximum !== undefined && value > field.maximum) return `must be at most ${field.maximum}`;
			return null;
		case "boolean":
			return typeof value === "boolean" ? null : "must be true or false";
		case "choice":
			return typeof value === "string" && field.options.some((option) => option.value === value)
				? null
				: "must be one of the listed options";
		case "multi":
			if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return "must be a list of options";
			if (new Set(value).size !== value.length) return "lists an option twice";
			if (value.some((item) => !field.options.some((option) => option.value === item)))
				return "names an option the form does not offer";
			if (field.minItems !== undefined && value.length < field.minItems)
				return `needs at least ${field.minItems} selected`;
			if (field.maxItems !== undefined && value.length > field.maxItems)
				return `allows at most ${field.maxItems} selected`;
			return null;
	}
}

/** Every reason a submitted form does not fit the fields it answers. */
export function elicitationContentErrors(
	fields: readonly ElicitationField[],
	content: Record<string, unknown>,
): string[] {
	const errors: string[] = [];
	for (const key of Object.keys(content))
		if (!fields.some((field) => field.key === key)) errors.push(`'${key}' is not a field of this form`);
	for (const field of fields) {
		if (!Object.hasOwn(content, field.key)) {
			if (field.required) errors.push(`${field.label} is required`);
			continue;
		}
		const error = elicitationValueError(field, content[field.key]);
		if (error !== null) errors.push(`${field.label} ${error}`);
	}
	return errors;
}
