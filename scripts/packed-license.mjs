// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The license files of the one pancode package, read as bytes.
 *
 * LICENSE and NOTICE must be the committed files, byte for byte, and they are
 * the only license files: packages/sdk/LICENSE stays out, because NOTICE tells
 * a reader that the Apache License 2.0 the extension API is under is the part
 * of LICENSE after its Additional Conditions. That part must therefore hold the terms of
 * packages/sdk/LICENSE exactly.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const APACHE_HEADING = "APACHE LICENSE, VERSION 2.0\n";
const END_OF_TERMS = "END OF TERMS AND CONDITIONS\n";

/** The Apache License 2.0 terms in `text`, from its title line through "END OF TERMS AND CONDITIONS". */
function apacheTerms(text) {
	const start = text.search(/^ +Apache License\n +Version 2\.0, January 2004\n/mu);
	const end = text.indexOf(END_OF_TERMS, start);
	return start < 0 || end < 0 ? undefined : text.slice(start, end + END_OF_TERMS.length);
}

/**
 * Problems with the license files of the package unpacked at `packageRoot`, whose
 * file list is `files` (paths relative to the package root), against the checkout
 * at `sourceRoot`. An empty array means the package passes.
 */
export function packedLicenseProblems(packageRoot, files, sourceRoot) {
	const problems = [];
	const shipped = new Set(files);
	for (const name of ["LICENSE", "NOTICE"]) {
		if (!shipped.has(name) || !existsSync(join(packageRoot, name))) {
			problems.push(`${name} is missing from the package`);
			continue;
		}
		if (!readFileSync(join(packageRoot, name)).equals(readFileSync(join(sourceRoot, name))))
			problems.push(`packed ${name} differs from the committed ${name}`);
	}
	if (shipped.has("packages/sdk/LICENSE"))
		problems.push("packages/sdk/LICENSE is in the package; the package carries one license file, LICENSE");
	if (shipped.has("LICENSE") && existsSync(join(packageRoot, "LICENSE"))) {
		const packed = readFileSync(join(packageRoot, "LICENSE"), "utf8");
		const sdkTerms = apacheTerms(readFileSync(join(sourceRoot, "packages/sdk/LICENSE"), "utf8"));
		const at = packed.indexOf(APACHE_HEADING);
		if (!sdkTerms) problems.push("packages/sdk/LICENSE does not hold the Apache License 2.0 terms");
		else if (at < 0 || apacheTerms(packed.slice(at)) !== sdkTerms)
			problems.push("packed LICENSE does not carry the Apache License 2.0 terms of packages/sdk/LICENSE");
	}
	return problems;
}
