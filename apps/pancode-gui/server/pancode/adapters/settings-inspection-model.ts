// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { redactSecretString } from "../../../../../src/lib/secrets/redaction.js";
import type { SettingRow } from "../../../contracts/settings.js";

/** Environment maps and executable argument vectors never enter the public projection. */
const privateSegment =
	/^(?:env|environment|argv|args|command|auth|authorization|headers|credentials|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password)$/i;
/**
 * A key whose last word names a secret, such as `githubToken`, `clientSecret` or `openaiApiKey`. The engine's
 * substring rule for tool arguments would also hide counts such as `maxTokens`, so settings match the last word only.
 */
const secretSuffix =
	/(?:api[-_]?key|access[-_]?key|private[-_]?key|secret[-_]?key|secret|pass(?:word|wd|phrase)|credentials?|token)$/i;
export function projectSettingsRows(settings: unknown, sources: Record<string, SettingRow["source"]>): SettingRow[] {
	const rows: SettingRow[] = [];
	function visit(value: unknown, segments: readonly string[], arrayOrigin?: SettingRow["source"]) {
		// Match the core settings-layer path grammar, including literal dotted map keys.
		const key = segments.reduce(
			(path, child) =>
				/^[\w-]+$/u.test(child) ? `${path ? `${path}.` : ""}${child}` : `${path}[${JSON.stringify(child)}]`,
			"",
		);
		// Object parents are also present in sources; they do not set absent default children.
		// Arrays replace wholesale, so their origin applies to every contained leaf.
		const source = sources[key] ?? arrayOrigin ?? "built-in";
		if (segments.some((part) => privateSegment.test(part) || secretSuffix.test(part))) {
			rows.push({ key, source, value: "[redacted]", redacted: true });
			return;
		}
		if (value && typeof value === "object") {
			const entries = Object.entries(value);
			if (!entries.length) rows.push({ key, source, value: Array.isArray(value) ? [] : {}, redacted: false });
			else
				for (const [child, item] of entries) visit(item, [...segments, child], Array.isArray(value) ? source : arrayOrigin);
			return;
		}
		if (typeof value === "string") {
			// URLs can carry credentials outside an auth-shaped key.
			try {
				const url = new URL(value);
				if (url.username || url.password || url.search || url.hash) {
					url.username = "";
					url.password = "";
					url.search = "";
					url.hash = "";
					rows.push({ key, source, value: redactSecretString(url.href).slice(0, 4096), redacted: true });
					return;
				}
			} catch {
				/* ordinary setting string */
			}
			// Credential shapes inside an ordinary value (`KEY=value`, `--token value`, a provider key) are scrubbed.
			const scrubbed = redactSecretString(value);
			rows.push({ key, source, value: scrubbed.slice(0, 4096), redacted: scrubbed !== value || value.length > 4096 });
		} else if (value === null || typeof value === "boolean" || typeof value === "number")
			rows.push({ key, source, value, redacted: false });
	}
	visit(settings, []);
	return rows.sort((a, b) => a.key.localeCompare(b.key));
}
