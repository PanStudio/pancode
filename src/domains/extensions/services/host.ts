// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The IPC face of the run, worktree, verify and claims services: one `{ op, ...arguments }` request from a runtime's
 * command or action becomes one service call. Only the shape is checked here (which op, which argument is text or a
 * list of text); each service checks the values against its own rules and the manifest's ceilings.
 */
import type { ExtensionRunRequest, ExtensionWorkPlace } from "@pancode/sdk/extension";
import type { ExtensionClaimsService } from "./claims.js";
import type { ExtensionRunService } from "./runs.js";
import type { ExtensionRequestScope } from "./scope.js";
import type { ExtensionVerifyService } from "./verify.js";
import type { ExtensionWorktreeService } from "./worktrees.js";

export type ExtensionWorkKind = "runs" | "worktrees" | "verify" | "claims";

/** One service call: the request as the runtime sent it, and the scope of the command or action that made it. */
export type ExtensionWorkCall = (request: Record<string, unknown>, scope: ExtensionRequestScope) => Promise<unknown>;

export type ExtensionWorkHost = Partial<Record<ExtensionWorkKind, ExtensionWorkCall>>;

export interface ExtensionWorkServices {
	runs?: ExtensionRunService;
	worktrees?: ExtensionWorktreeService;
	verify?: ExtensionVerifyService;
	claims?: ExtensionClaimsService;
}

class Request {
	constructor(
		private readonly kind: ExtensionWorkKind,
		readonly op: string,
		private readonly raw: Record<string, unknown>,
	) {}
	private fail(field: string, what: string): never {
		throw new Error(`${this.kind}.${this.op}: ${field} must be ${what}`);
	}
	text(field: string): string {
		const value = this.raw[field];
		if (typeof value !== "string") this.fail(field, "text");
		return value;
	}
	texts(field: string): string[] {
		const value = this.raw[field];
		if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) this.fail(field, "a list of text");
		return value as string[];
	}
	value(field: string): unknown {
		return this.raw[field];
	}
	optionalText(field: string): string | undefined {
		return this.raw[field] === undefined ? undefined : this.text(field);
	}
	optionalFlag(field: string): boolean | undefined {
		const value = this.raw[field];
		if (value !== undefined && typeof value !== "boolean") this.fail(field, "true or false");
		return value;
	}
	optionalTexts(field: string): string[] | undefined {
		return this.raw[field] === undefined ? undefined : this.texts(field);
	}
	optionalNumber(field: string): number | undefined {
		const value = this.raw[field];
		if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value)))
			this.fail(field, "a finite number");
		return value;
	}
	place(field = "place"): ExtensionWorkPlace | undefined {
		const value = this.raw[field];
		if (value === undefined || value === "workspace") return value;
		if (value === null || typeof value !== "object" || Array.isArray(value)) this.fail(field, "workspace or a worktree");
		const { worktree, sub, ...rest } = value as Record<string, unknown>;
		if (typeof worktree !== "string" || (sub !== undefined && typeof sub !== "string") || Object.keys(rest).length > 0)
			this.fail(field, "workspace or { worktree, sub? }");
		return sub === undefined ? { worktree } : { worktree, sub };
	}
	object(field: string): Record<string, unknown> {
		const value = this.raw[field];
		if (value === null || typeof value !== "object" || Array.isArray(value)) this.fail(field, "an object");
		return value as Record<string, unknown>;
	}
}

function dispatcher<T>(
	kind: ExtensionWorkKind,
	service: T | undefined,
	ops: Record<string, (service: T, request: Request, scope: ExtensionRequestScope) => Promise<unknown>>,
): ExtensionWorkCall | undefined {
	if (service === undefined) return undefined;
	return (raw, scope) => {
		const op = raw.op;
		if (typeof op !== "string" || !Object.hasOwn(ops, op))
			return Promise.reject(new Error(`${kind}: unknown operation ${String(op).slice(0, 40)}`));
		const { op: _, ...rest } = raw;
		try {
			return (ops[op] as (typeof ops)[string])(service, new Request(kind, op, rest), scope);
		} catch (error) {
			return Promise.reject(error);
		}
	};
}

/** Drops absent arguments, so an optional one the runtime left out reaches the service as absent. */
function omitUndefined<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
		[K in keyof T]?: Exclude<T[K], undefined>;
	};
}

export function createExtensionWorkHost(services: ExtensionWorkServices): ExtensionWorkHost {
	const host: ExtensionWorkHost = {};
	const runs = dispatcher("runs", services.runs, {
		start: (service, request, scope) => service.start(request.object("run") as unknown as ExtensionRunRequest, scope),
		frames: (service, request, scope) =>
			service.frames(
				request.text("id"),
				omitUndefined({
					cursor: request.optionalNumber("cursor"),
					limit: request.optionalNumber("limit"),
					waitMs: request.optionalNumber("waitMs"),
				}),
				scope,
			),
		wait: (service, request) => service.wait(request.text("id")),
		cancel: (service, request) => service.cancel(request.text("id")).then(() => null),
		refusal: (service, request) => {
			const autonomy = request.optionalText("autonomy");
			if (autonomy !== undefined && autonomy !== "default" && autonomy !== "yolo")
				throw new Error("runs.refusal: autonomy must be default or yolo");
			return service.refusal(omitUndefined({ autonomy, readOnly: request.optionalFlag("readOnly") }));
		},
	});
	const worktrees = dispatcher("worktrees", services.worktrees, {
		create: (service, request, scope) =>
			service.create(
				omitUndefined({
					base: request.optionalText("base"),
					copy: request.optionalTexts("copy"),
					keep: request.optionalFlag("keep"),
				}),
				scope,
			),
		list: (service) => service.list(),
		remove: (service, request) => service.remove(request.text("id")).then(() => null),
		git: (service, request) => service.git(request.place() ?? "workspace", request.texts("args")),
		checkout: (service, request) => service.checkout(request.text("id"), request.text("commit")).then(() => null),
		clean: (service, request) =>
			service.clean(request.text("id"), omitUndefined({ keep: request.optionalTexts("keep") })).then(() => null),
		copy: (service, request) => service.copy(request.text("id"), request.texts("paths")).then(() => null),
		commit: (service, request) =>
			service.commit(
				request.text("id"),
				request.text("message"),
				omitUndefined({ leaveOut: request.optionalTexts("leaveOut") }),
			),
		"refs.get": (service, request) => service.refs.get(request.text("name")),
		"refs.create": (service, request) =>
			service.refs.create(request.text("name"), request.text("commit")).then(() => null),
		"refs.swap": (service, request) =>
			service.refs.swap(request.text("name"), request.text("to"), request.text("from"), request.text("message")),
	});
	const verify = dispatcher("verify", services.verify, {
		list: (service, request) => service.list(request.place()),
		resolve: (service, request) => service.resolve(request.text("id"), request.place()),
		check: (service, request, scope) => service.check(request.text("id"), request.place(), scope),
		measure: (service, request, scope) =>
			service.measure(request.text("id"), request.text("metric"), request.place(), scope),
	});
	const claims = dispatcher("claims", services.claims, {
		hypotheses: (service, request) => service.hypotheses(request.text("name"), request.text("slate")),
		begin: (service, request) => service.begin(request.text("run"), request.texts("checks")),
		finish: (service, request) => {
			const outcomes = request.value("outcomes");
			if (
				!Array.isArray(outcomes) ||
				outcomes.some(
					(entry) =>
						entry === null ||
						typeof entry !== "object" ||
						typeof (entry as Record<string, unknown>).check !== "string" ||
						typeof (entry as Record<string, unknown>).receipt !== "string",
				)
			)
				throw new Error("claims.finish: outcomes must be a list of { check, receipt }");
			const pairs = (outcomes as Array<{ check: string; receipt: string }>).map(({ check, receipt }) => ({
				check,
				receipt,
			}));
			return service.finish(
				request.text("run"),
				pairs,
				omitUndefined({ withoutClaim: request.optionalTexts("withoutClaim") }),
			);
		},
		read: (service, request) => {
			const types = request.optionalTexts("types") as Array<"claim" | "hypothesis" | "hypothesis-test"> | undefined;
			return service.read(omitUndefined({ types, limit: request.optionalNumber("limit") }));
		},
	});
	if (runs) host.runs = runs;
	if (worktrees) host.worktrees = worktrees;
	if (verify) host.verify = verify;
	if (claims) host.claims = claims;
	return host;
}
