// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { randomUUID } from "node:crypto";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { Problem, ProblemCode } from "../../contracts/common.js";

const statusByCode: Record<ProblemCode, number> = {
	validation: 422,
	unauthorized: 401,
	not_found: 404,
	conflict: 409,
	unsupported: 409,
	unavailable: 503,
	upstream_acp: 409,
	operation_failed: 500,
	internal: 500,
};
export class AppProblem extends Error {
	readonly problem: Problem;
	constructor(
		code: ProblemCode,
		detail: string,
		status = statusByCode[code],
		instance: string = randomUUID(),
		extensions: Pick<Problem, "modelSelection" | "control"> = {},
	) {
		super(detail);
		this.problem = {
			type: `urn:pancode:problem:${code}`,
			title: code.replaceAll("_", " "),
			status,
			detail,
			code,
			instance,
			...extensions,
		};
	}
}
export function problemOf(error: unknown): Problem {
	if (error instanceof AppProblem) return error.problem;
	const problem = new AppProblem("internal", "The request could not be completed.").problem;
	console.error(`[pancode:gui] ${problem.instance}`, error);
	return problem;
}

/**
 * `raw` cut down to `schema`'s fields; a value that still does not match is the `code` problem. `clone` keeps the
 * caller's object intact, since Value.Clean removes the unknown fields in place.
 */
export function projected<S extends TSchema>(
	schema: S,
	raw: unknown,
	code: ProblemCode,
	message: string,
	{ clone = false } = {},
): Static<S> {
	const value = Value.Clean(schema, clone ? structuredClone(raw) : raw);
	if (!Value.Check(schema, value)) throw new AppProblem(code, message);
	return value;
}

/** A request path or path segment, percent-decoded; malformed encoding is the caller's error (400), not ours. */
export function decodeRequestPath(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		throw new AppProblem("validation", "The request path has malformed percent-encoding.", 400);
	}
}
