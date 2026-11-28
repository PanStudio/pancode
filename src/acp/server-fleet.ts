// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Fleet requests over ACP: the playbook name, variables and resume id a
 * client sends, and the preview compile that checks them.
 */

import { isRecord } from "../core/type-guards.js";
import { AcpRequestError, acpErrorMessage } from "./errors.js";
import type { AcpFleetControl } from "./fleet-run.js";
import { requireBoundedClientString } from "./server-bounds.js";
import type { PancodeAcpServerOptions } from "./server-options.js";

export const requireFleet = (options: PancodeAcpServerOptions): AcpFleetControl => {
	if (options.fleet === undefined) throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
	return options.fleet;
};

/** A playbook name is a file stem under the workspace's playbooks, never a path. */
export const fleetName = (value: unknown): string => {
	const name = requireBoundedClientString(value, "name", 128);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) || name.includes("..")) {
		throw new AcpRequestError(-32602, "name is invalid", { code: "invalid_params" });
	}
	return name;
};

export const fleetVars = (value: unknown): Record<string, string> => {
	if (value === undefined) return {};
	if (!isRecord(value) || Object.keys(value).length > 32) {
		throw new AcpRequestError(-32602, "vars must be an object of at most 32 strings", { code: "invalid_params" });
	}
	const vars: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(key)) {
			throw new AcpRequestError(-32602, "a variable name is invalid", { code: "invalid_params" });
		}
		vars[key] = requireBoundedClientString(entry, "vars", 4096, { allowEmpty: true });
	}
	return vars;
};

/** A fleet root id, never a path: the durable ledger keys records by it. */
export const fleetResume = (value: unknown): string | undefined => {
	if (value === undefined) return undefined;
	const id = requireBoundedClientString(value, "resume", 128);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id) || id.includes("..")) {
		throw new AcpRequestError(-32602, "resume is invalid", { code: "invalid_params" });
	}
	return id;
};

export const compileFleet = (
	options: PancodeAcpServerOptions,
	control: AcpFleetControl,
	name: string,
	vars: Record<string, string>,
	resume?: string,
) => {
	try {
		return control.preview(name, vars, resume);
	} catch (error) {
		options.diagnostics?.(`fleet preview failed: ${acpErrorMessage(error)}`);
		throw new AcpRequestError(-32603, "fleet preview failed", { code: "internal_error" });
	}
};
