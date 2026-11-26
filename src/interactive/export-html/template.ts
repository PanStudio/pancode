// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { roleHex, type SemanticRole, type ThemeBackground } from "../theme/tokens.js";
import { escapeHtml } from "./ansi-to-html.js";

export interface HtmlTemplateInput {
	sessionId: string;
	exportedAt: string;
	transcriptHtml: string;
	truncated: boolean;
}

const PAGE_ROLES = {
	card: "raisedSurface",
	text: "body",
	muted: "annotation",
	frame: "border",
	rail: "transcriptRule",
	accent: "wordmark",
	warning: "warning",
	"warning-rule": "attentionRail",
} as const satisfies Record<string, SemanticRole>;

/** The terminal theme's own colours, so an export reads like the session it came from. */
function pageColors(background: ThemeBackground): string {
	return Object.entries(PAGE_ROLES)
		.map(([name, role]) => `--${name}: ${roleHex(role, background)};`)
		.join(" ");
}

/** A self-contained document: no scripts, fonts, stylesheets, or remote URLs. */
export function htmlTemplate(input: HtmlTemplateInput): string {
	const title = `PanCode session ${input.sessionId}`;
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; --page: black; ${pageColors("dark")} }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--page); color: var(--text); font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
    main { width: min(112ch, calc(100% - 32px)); margin: 32px auto; }
    header { margin-bottom: 20px; padding: 18px 20px; border: 1px solid var(--frame); border-radius: 10px; background: var(--card); }
    h1 { margin: 0 0 6px; color: var(--accent); font: 600 20px/1.3 system-ui, sans-serif; }
    header p { margin: 0; color: var(--muted); }
    .transcript { white-space: pre-wrap; overflow-wrap: anywhere; }
    .ansi-line { min-height: 1.45em; }
    .transcript-row { padding: 0 12px; }
    .tool-row { margin: 8px 0; padding: 9px 12px; border-left: 2px solid var(--rail); border-radius: 0 7px 7px 0; background: var(--card); }
    .truncated { margin-top: 18px; padding: 10px 12px; border: 1px solid var(--warning-rule); border-radius: 7px; color: var(--warning); }
    @media print { :root { color-scheme: light; --page: white; ${pageColors("light")} } main { width: 100%; margin: 0; } }
  </style>
</head>
<body>
  <main>
    <header><h1>${escapeHtml(title)}</h1><p>Exported ${escapeHtml(input.exportedAt)}</p></header>
    <section class="transcript" aria-label="Session transcript">
${input.transcriptHtml}
    </section>
${input.truncated ? '    <p class="truncated">The transcript was truncated to keep this HTML export within its size limit.</p>\n' : ""}  </main>
</body>
</html>
`;
}
