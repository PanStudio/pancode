// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The fields of an MCP form elicitation and the check of a value against one. The runtime checks an answer with it
 * before anything reaches the server, and the GUI checks the same answer as it is typed. Browser-safe: no imports.
 */

type McpStringFormat = "email" | "uri" | "date" | "date-time";

export interface McpFieldOption {
	value: string;
	label: string;
}

export interface McpFieldBase {
	key: string;
	/** The schema's title, else the key. */
	label: string;
	description?: string;
	required: boolean;
}

export type McpFormField =
	| (McpFieldBase & {
			kind: "string";
			minLength?: number;
			maxLength?: number;
			format?: McpStringFormat;
			default?: string;
	  })
	| (McpFieldBase & { kind: "number"; integer: boolean; minimum?: number; maximum?: number; default?: number })
	| (McpFieldBase & { kind: "boolean"; default?: boolean })
	| (McpFieldBase & { kind: "choice"; options: McpFieldOption[]; default?: string })
	| (McpFieldBase & {
			kind: "multi";
			options: McpFieldOption[];
			minItems?: number;
			maxItems?: number;
			default?: string[];
	  });

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/u;

// Read field by field: `Date.UTC` maps years 0-99 to 1900-1999, so a round trip refuses `0099-01-01`.
function validDate(text: string): boolean {
	const match = DATE.exec(text);
	if (match === null) return false;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	if (month < 1 || month > 12 || day < 1) return false;
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = month === 2 ? (leap ? 29 : 28) : month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
	return day <= days;
}

// Check time and offset fields directly too: `Date.parse` accepts `24:00:00Z` and `+25:00` in V8 and is
// implementation-defined for space-separated RFC 3339 timestamps across browsers.
function validDateTime(text: string): boolean {
	const match = DATE_TIME.exec(text);
	if (match === null) return false;
	const [, date, hour, minute, second, offsetHour, offsetMinute] = match;
	if (date === undefined || !validDate(date)) return false;
	if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
	if (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return false;
	return true;
}

function formatError(format: McpStringFormat, text: string): string | null {
	switch (format) {
		case "email":
			return EMAIL.test(text) ? null : "must be an email address";
		case "uri":
			return /^[a-z][a-z0-9+.-]*:/iu.test(text) && !/[\s\p{Cc}]/u.test(text) && URL.canParse(text)
				? null
				: "must be an absolute URI";
		case "date":
			return validDate(text) ? null : "must be a date like 2026-07-28";
		case "date-time":
			return validDateTime(text) ? null : "must be a date and time like 2026-07-28T09:30:00Z";
	}
}

/** Why one value does not fit its field, or null when it does. */
export function elicitationValueError(field: McpFormField, value: unknown): string | null {
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

/**
 * Every reason submitted content does not fit the form's fields, one line each; empty when it fits
 * (client/elicitation, Form Mode Security: clients SHOULD validate responses).
 */
export function elicitationContentErrors(fields: readonly McpFormField[], content: Record<string, unknown>): string[] {
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
