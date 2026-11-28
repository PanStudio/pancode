// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Which hub rows the desktop may act on, and what an extension row offers instead. The plan contract's
// `packageRef` names only the PACKAGE_KINDS, so a button on any other kind is a guaranteed 400. Extension
// consent (the capability envelope review) stays in the terminal. Pure, so the commands are testable without a browser.

import {
	copyOperations,
	matchesPackage,
	missingScopes,
	PACKAGE_KINDS,
	type Package,
	type Scope,
	verb,
} from "./hub-plan.js";

export interface TerminalStep {
	label: string;
	command: string;
}

export const TERMINAL_NOTE =
	"Extensions are reviewed and changed in the terminal, where their capability envelope is shown for approval. Run one of these, or open /hub in PanCode.";

/** True when the plan contract accepts this package's ref, so the catalog may offer Install, Update, Enable, Disable and Remove. */
export const desktopManaged = (pkg: Pick<Package, "kind">): boolean =>
	(PACKAGE_KINDS as readonly string[]).includes(pkg.kind);

const scopeFlag = (scope: Scope) => `--${scope}`;

/** The terminal command for each action the catalog would have offered on this row, in the order it would have offered them. */
export function terminalSteps(pkg: Package): TerminalStep[] {
	const steps: TerminalStep[] = [];
	for (const copy of pkg.copies) {
		const scope = copy.scope as Scope;
		for (const operation of copyOperations(String(copy.state))) {
			steps.push({
				label: `${verb(operation)} the ${scope} copy`,
				command: `pancode hub ${operation} ${pkg.ref} ${scopeFlag(scope)}`,
			});
		}
	}
	if (pkg.catalogOrigin !== "installed") {
		for (const scope of missingScopes(pkg)) {
			steps.push(
				scope === "user"
					? { label: "Install for me", command: `pancode hub install ${pkg.ref}` }
					: { label: "Install in this project", command: `pancode hub install ${pkg.ref} --project` },
			);
		}
	}
	return steps;
}

export function catalogKinds(packages: readonly Package[]): string[] {
	return [...new Set([...PACKAGE_KINDS, ...packages.map((pkg) => pkg.kind)])].filter((kind) =>
		packages.some((pkg) => pkg.kind === kind),
	);
}

/** The kind filter in force: a kind the catalog holds, or "all" for anything else in the address. */
export const catalogKind = (kinds: readonly string[], value: string | null | undefined): string =>
	kinds.find((candidate) => candidate === value) ?? "all";

/** The kind buttons: "All kinds" first, then every kind with at least one pack, each with its count. */
export function catalogFacets(packages: readonly Package[], kinds: readonly string[]) {
	return ["all", ...kinds]
		.filter((name) => name === "all" || packages.some((pkg) => pkg.kind === name))
		.map((name) => ({
			name,
			label: name === "all" ? "All kinds" : `${name[0]?.toUpperCase()}${name.slice(1)} packs`,
			count: name === "all" ? packages.length : packages.filter((pkg) => pkg.kind === name).length,
		}));
}

/**
 * The packs the filters keep, the first `limit` of them shown with the selected pack pinned first when it falls past
 * the limit, and whether a selected pack is hidden by the filters or gone.
 */
export function catalogView(
	packages: readonly Package[],
	view: { kind: string; installedOnly: boolean; filter: string; selected: string | null | undefined; limit: number },
) {
	const visible = packages.filter(
		(pkg) =>
			(view.kind === "all" || pkg.kind === view.kind) &&
			(!view.installedOnly || pkg.copies.length > 0) &&
			matchesPackage(pkg, view.filter),
	);
	const displayed = visible.slice(0, view.limit);
	const selectedPackage = visible.find((pkg) => pkg.ref === view.selected);
	if (selectedPackage && !displayed.includes(selectedPackage)) displayed.unshift(selectedPackage);
	return {
		visible,
		installed: packages.filter((pkg) => pkg.copies.length > 0).length,
		displayed,
		selectionHidden: !!view.selected && !selectedPackage,
	};
}

export const applyLabel = (steps: number, pending: boolean): string =>
	pending ? "Applying…" : `Apply ${steps === 1 ? "this change" : `${steps} changes`}`;
