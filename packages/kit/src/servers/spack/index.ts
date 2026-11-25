// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The `spack` server: what a Spack instance has installed, what a package
 * offers, where a spec or package lives, how a spec would concretize, and its
 * environments. The instance is the one the caller's environment names:
 * `spack` on `PATH`, else `$SPACK_ROOT/bin/spack`.
 */
import { defineServer } from "@pancode/sdk/tool";
import type { ServerProbe } from "../../registry.js";
import { locateSpack, readSpackVersion, SPACK_ENVIRONMENT } from "./program.js";
import { SPACK_TOOLS } from "./tools.js";

export const server = defineServer({ id: "spack", version: "0.1.0", title: "Spack packages", tools: SPACK_TOOLS });

export const environment = SPACK_ENVIRONMENT;

/** Where `spack` was found and the version its checkout declares, read from a file: no command runs and no lock is taken. */
export async function probe(): Promise<ServerProbe> {
	const found = locateSpack();
	if (found.path === null)
		return { available: false, reason: found.reason, sources: [{ name: "spack", found: false, detail: found.reason }] };
	const { version, reason } = await readSpackVersion(found.path);
	const detail = `${found.path} (via ${found.via}), ${version === null ? `version unknown: ${reason}` : `version ${version}`}`;
	return { available: true, sources: [{ name: "spack", found: true, detail }] };
}
