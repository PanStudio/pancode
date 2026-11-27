// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Expanded footer surfaces and machine health block.
 *
 * Delegates the bottom status line to `status-line.ts` and the `Alt+U` boxed island deck
 * drawer to `deck-drawer.ts`, while keeping `machineBlock` exported for the `/usage` Health tab.
 */

import { visibleWidth } from "../../engine/tui.js";
import { sanitizeCallTargetText } from "../../lib/call-target/call-target.js";
import { redactSecretString } from "../../lib/secrets/redaction.js";
import { factRows, GLYPH, meter, pancodeTheme, sectionRule, type Tone } from "../theme/index.js";
import type { FooterDashboardRenderState } from "./dashboard.js";
import { renderDeckDrawer } from "./deck-drawer.js";
import { renderStatusLine } from "./status-line.js";
import type { LocalMachineMetrics } from "./system-metrics.js";
import { zipColumns } from "./widgets.js";

/** At this width and above a page lays its sections out in two columns. */
const FOOTER_SPLIT_COLUMNS = 84;
const clean = (value: string) => sanitizeCallTargetText(redactSecretString(value));

/** Two column blocks beside each other, or stacked when the page is narrow. */
function columns(left: string[], right: string[], width: number): string[] {
	if (width < FOOTER_SPLIT_COLUMNS) return [...left, ...right];
	const leftWidth = Math.floor((width - 3) / 2);
	return zipColumns(left, right, leftWidth, width - leftWidth - 3, "   ");
}

/** The longest bar a page meter draws; past this a wide terminal gets room, not resolution. */
const PAGE_METER_CELLS = 48;

/** `label ━━━━━━──── 62%` for a page meter whose tone names the limit it approaches. */
function pageMeter(label: string, value: number | null, max: number, width: number, amount?: string): string {
	const theme = pancodeTheme();
	if (value === null || !Number.isFinite(value)) {
		return `${theme.fg("fieldName", label)} ${theme.fg("unknownValue", "warming up")}`;
	}
	const ratio = max > 0 ? value / max : 0;
	const tone: Tone | "meter" = ratio >= 0.95 ? "error" : ratio >= 0.8 ? "warning" : "meter";
	const shown = amount ?? `${Math.round(ratio * 100)}%`;
	const capped = Math.min(width, visibleWidth(label) + 1 + PAGE_METER_CELLS + 1 + visibleWidth(shown));
	return meter(theme, { label, value, max, width: capped, tone, amount: shown });
}

/**
 * The local machine: CPU, memory, GPU, network and disk, as the Health tab of
 * `/usage` shows them while it samples.
 */
export function machineBlock(resource: LocalMachineMetrics | null, now: number, width: number): string[] {
	const theme = pancodeTheme();
	const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
	const mib = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
	const throughput = (value: number) =>
		value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB/s` : `${(value / 1024).toFixed(1)} KiB/s`;
	const value = (text: string): string =>
		theme.fg(
			/^(unknown|unreported|unavailable|not sampled|sampling|warming up|pending|not available|not reported)/u.test(text)
				? "unknownValue"
				: "fieldValue",
			clean(text),
		);
	const facts = (entries: ReadonlyArray<readonly [string, string]>, room: number): string[] =>
		factRows(
			theme,
			entries.map(([label, text]) => ({ label, value: value(text), fit: "clip" as const })),
			room,
			{ labelWidth: 14 },
		);
	const half = Math.floor((width - 3) / 2);
	const cpu = pageMeter("CPU", resource ? resource.cpuPercent : null, 100, width >= FOOTER_SPLIT_COLUMNS ? half : width);
	const ramUsed = resource ? resource.hostTotalBytes - resource.hostFreeBytes : null;
	const ram = resource
		? pageMeter(
				"RAM",
				ramUsed,
				resource.hostTotalBytes,
				width >= FOOTER_SPLIT_COLUMNS ? width - half - 3 : width,
				`${Math.round(((ramUsed ?? 0) / resource.hostTotalBytes) * 100)}% ${theme.fg("fieldValue", `${gib(ramUsed ?? 0)} / ${gib(resource.hostTotalBytes)}`)}`,
			)
		: pageMeter("RAM", null, 100, width);
	const gpu = resource?.gpu
		? resource.gpu.busyPercent === null
			? `${theme.fg("fieldName", "GPU")} ${value(
					`${resource.gpu.name} ${GLYPH.sep} load unavailable${
						resource.gpu.usedBytes != null && resource.gpu.totalBytes != null
							? ` ${GLYPH.sep} ${gib(resource.gpu.usedBytes)} / ${gib(resource.gpu.totalBytes)}`
							: ""
					}`,
				)}`
			: pageMeter(
					`GPU ${clean(resource.gpu.name)}`,
					resource.gpu.busyPercent,
					100,
					width >= FOOTER_SPLIT_COLUMNS ? half : width,
					`${resource.gpu.busyPercent}%${
						resource.gpu.usedBytes != null && resource.gpu.totalBytes != null
							? ` ${theme.fg("fieldValue", `${gib(resource.gpu.usedBytes)} / ${gib(resource.gpu.totalBytes)}`)}`
							: ""
					}`,
				)
		: `${theme.fg("fieldName", "GPU")} ${value("unavailable on this OS/driver")}`;
	const rss = `${theme.fg("fieldName", "PanCode RSS")} ${resource ? theme.fg("fieldValue", mib(resource.processRssBytes)) : value("sampling")}`;
	const machine = [
		sectionRule(theme, width, "Machine", {
			meta: resource
				? `${resource.scope} ${GLYPH.sep} sampled ${Math.max(0, Math.round((now - resource.sampledAt) / 1000))}s ago`
				: `local OS ${GLYPH.sep} sampling`,
		}),
		...columns([cpu], [ram], width),
		...columns([gpu], [rss], width),
		...facts(
			[
				[
					"Network",
					resource?.network
						? `${resource.network.name} ${GLYPH.down} ${throughput(resource.network.receivedPerSecond)} ${GLYPH.up} ${throughput(resource.network.sentPerSecond)}`
						: "warming up / unavailable",
				],
				[
					"Disk I/O",
					resource?.disk
						? `${resource.disk.name} R ${throughput(resource.disk.readPerSecond)} W ${throughput(resource.disk.writtenPerSecond)}`
						: "warming up / unavailable",
				],
				["Sampling", resource ? "every 2s" : "pending"],
				["Scope", `${resource?.scope ?? "local OS"} ${GLYPH.sep} busiest interface/disk ${GLYPH.sep} local only`],
			],
			width,
		),
	];

	return machine;
}

/**
 * Render the bottom status line region (Hybrid B->A). Delegates to `src/interactive/footer/status-line.ts`.
 */
export function renderCompactDashboard(
	state: FooterDashboardRenderState,
	width: number,
	terminalRows = Number.POSITIVE_INFINITY,
): string[] {
	return renderStatusLine(state, width, terminalRows);
}

/**
 * Render the Alt+U boxed island deck drawer (`Route`, `Work`, `Context`).
 * Delegates to `src/interactive/footer/deck-drawer.ts`.
 */
export function dashboardPageViewport(
	state: FooterDashboardRenderState,
	width: number,
	terminalRows: number,
	_toggleKey: string,
): string[] {
	return renderDeckDrawer(state, width, terminalRows);
}
