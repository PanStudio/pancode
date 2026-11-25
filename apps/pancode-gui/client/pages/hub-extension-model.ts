// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Which PanHub rows the desktop may act on, and what an extension row offers instead. The plan contract's
// `packageRef` names only the PACKAGE_KINDS, so a button on any other kind is a guaranteed 400. Extension
// consent (the capability envelope review) stays in the terminal. Pure, so the commands are testable without a browser.

import { copyOperations, missingScopes, PACKAGE_KINDS, type Package, type Scope, verb } from "./hub-plan.js";

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
