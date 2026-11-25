// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** The worker card body: progress, answer, trust and evidence lines for one selected run. */
import type { OutputStyle } from "../core/defaults.js";
import { tierPolicy } from "../core/presentation-tier.js";
import {
	USAGE_NOT_MEASURED,
	usageFigure,
	usageLineCoverage,
	usageLineFigure,
	usageSaysNothing,
} from "../core/views/usage-words.js";
import { budgetLimitWords } from "../domains/dispatch/budget-envelope.js";
import { reviewFindingsWords, workerFailureHeadline } from "../domains/dispatch/failure-headline.js";
import { describeWriteBoundaryAttributionDowngrade } from "../domains/dispatch/write-boundary.js";
import { plainTrustVerdict } from "../domains/evidence/trust-projection.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import type { WorkerProgressSnapshot } from "../domains/telemetry/worker-progress.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import { planCardBody } from "./dispatch-plan-card.js";
import {
	actionPhrase,
	boundMark,
	CARD_KV_KEY_WIDTH,
	cardKvKey,
	cardUnitsLine,
	cardWrappedValueLines,
	completedRunFailure,
	type DispatchBoardRow,
	dispatchStatusPresentation,
	dispatchUsageText,
	evidenceStatePresentation,
	isTerminalStatus,
	RUNTIME_REACH_WORDS,
	type RunEvidencePresentation,
	retryCountdown,
	runOriginWords,
	SEP,
	terminalDetail,
	trustVerdictMark,
	trustVerdictToken,
	WORKER_PROGRESS_CARD_ROWS,
	wallTokenRate,
} from "./dispatch-row-model.js";
import type { RouteFirstOutput } from "./footer/silence-note.js";
import { cutRowWithEllipsis } from "./overlay-frame.js";
import { liveWorkerAnswerText, presentSettledWorkerAnswer } from "./renderers/worker-answer.js";
import type { PancodeTheme } from "./theme/index.js";
import { animationStep, dotSep, formatTargetLabel, GLYPH, pancodeTheme } from "./theme/index.js";
import { fitIdentityLabel } from "./theme/labels.js";
import {
	approvalWaitWords,
	compactQuantity,
	completedRunMark,
	workerActionParts,
	workerPhaseActivity,
	workerSilenceWords,
} from "./worker-activity.js";

// The `proof` row: the colored state marker, then the dim `/view` filter an operator would type.
export function evidenceCardLine(
	theme: PancodeTheme,
	evidence: RunEvidencePresentation,
	contentWidth: number,
): string | null {
	const presentation = evidenceStatePresentation(evidence.state);
	if (!presentation) return null;
	const units = [theme.fg(presentation.token, `${presentation.glyph} ${presentation.word} to inspect`)];
	units.push(theme.fg("annotation", `/view ${evidence.viewFilter}`));
	return cardUnitsLine(theme, "evidence", units, contentWidth);
}

/** The phase word an expanded card names, or null for a phase that says nothing new. */
function progressPhaseUnit(theme: PancodeTheme, progress: WorkerProgressSnapshot): string | null {
	// The phase only, in the words the dock and the inline card use. Reasoning content never reaches an operator surface.
	if (progress.verification === undefined && (progress.phase === "settled" || progress.phase === "starting"))
		return null;
	const [glyph, words] = workerPhaseActivity(progress);
	return theme.fg("dispatchAction", `${glyph} ${words}`);
}

/**
 * The `doing` row: the phase, then the running call or the most recent one, with its object. A model gone quiet adds
 * how long and whether that is usual for the route, the words the table row and the rail use.
 */
export function progressActionLine(
	theme: PancodeTheme,
	progress: WorkerProgressSnapshot,
	contentWidth: number,
	history: RouteFirstOutput | null,
): string | null {
	const phase = progressPhaseUnit(theme, progress);
	const current = progress.currentAction;
	const recent = progress.recentActions[0];
	const units: string[] = [];
	const silence = workerSilenceWords(progress, { history, room: contentWidth - 22 });
	// A silence already says what the worker waits on and for how long, so the bare phase would only repeat it.
	if (phase !== null && current === null && silence === null) units.push(phase);
	if (silence !== null) units.push(theme.fg("warning", silence));
	if (progress.awaitingApproval === true && current !== null) {
		const wanted = workerActionParts(current, "running");
		units.push(
			theme.fg("warning", approvalWaitWords(progress, { room: contentWidth - 12 })),
			theme.fg("toolTarget", `${wanted.verb} ${wanted.object}`.trim()),
		);
	} else if (current !== null)
		units.push(theme.base("body", `${theme.fg("toolMetadata", "now:")} ${actionPhrase(current, "running")}`));
	else if (recent !== undefined)
		units.push(theme.base("body", `${theme.fg("toolMetadata", "last:")} ${actionPhrase(recent, "finished")}`));
	if (units.length === 0) return null;
	return cardUnitsLine(theme, "doing", units, contentWidth);
}

/**
 * The `answer` block: the newest rows of the worker's bounded prose on a rail,
 * then what is not shown and where to read it. Wrapping happens before the row
 * cap, so the block is at most {@link WORKER_PROGRESS_CARD_ROWS} rows tall
 * whatever the terminal width, and a streaming answer cannot make the card grow
 * under the operator.
 */
function progressAnswerLines(
	theme: PancodeTheme,
	progress: WorkerProgressSnapshot,
	runId: string,
	contentWidth: number,
	run: Pick<DispatchBoardRow, "resultContract" | "trust" | "commitPlacement">,
	maxRows = WORKER_PROGRESS_CARD_ROWS,
): string[] {
	if (progress.tailText.length === 0) return [];
	const gutter = CARD_KV_KEY_WIDTH + 1;
	const railWidth = Math.max(1, contentWidth - gutter - 2);
	const complete = progress.droppedLines === 0 && progress.droppedBytes === 0;
	const presented = progress.settled
		? presentSettledWorkerAnswer(
				progress.tailText,
				run.resultContract,
				run.trust?.axes.artifactIntegrity === "verified",
				complete,
				run.commitPlacement,
			)
		: null;
	const source = presented
		? [...(presented.footer ? [presented.footer] : []), ...presented.lines]
		: liveWorkerAnswerText(progress.tailText, progress.completed === true).split("\n");
	const wrapped: string[] = [];
	for (const line of source) {
		for (const row of wrapTextWithAnsi(sanitizeCallTargetText(line), railWidth)) wrapped.push(row);
	}
	const shown = progress.settled ? wrapped.slice(0, maxRows) : wrapped.slice(Math.max(0, wrapped.length - maxRows));
	const hiddenRows = wrapped.length - shown.length;
	const rail = theme.fg("gutter", `${GLYPH.rail} `);
	const body = shown.map((row) => `${rail}${theme.fg("assistantProse", row)}`);
	const hiddenLines = progress.droppedLines + hiddenRows;
	if (hiddenLines > 0 || progress.droppedBytes > 0) {
		const facts = [
			`/view dispatch:${runId}`,
			...(hiddenLines > 0 ? [`${hiddenLines} more line${hiddenLines === 1 ? "" : "s"}`] : []),
			...(progress.droppedBytes > 0 ? [`${progress.droppedBytes} bytes outran the view`] : []),
		];
		body.push(`${rail}${theme.fg("annotation", truncateToWidth(facts.join(SEP), railWidth, GLYPH.ellipsis, false))}`);
	}
	// The key labels the block once and the rest hangs under it, which is the
	// card's key-value grammar applied to a body rather than to one value.
	return body.map((row, index) => `${index === 0 ? cardKvKey(theme, "answer") : " ".repeat(gutter)}${row}`);
}

/** Axis states a reader must see spelled out, because the verdict's words alone do not carry them. */
const EXCEPTIONAL_TRUST_STATES: ReadonlySet<string> = new Set([
	"failed",
	"unknown",
	"ungrounded",
	"invalid",
	"inconclusive",
	"not_independent",
]);

/**
 * The run's verdict in plain words. Under it the axis record shows only when an axis is out of the ordinary (unknown,
 * failed, inferred), folded or open: an ordinary sealed run's axes only restate the verdict in the receipt's
 * vocabulary, so for it they stay in /view.
 */
export function trustCardLines(
	theme: PancodeTheme,
	row: DispatchBoardRow,
	contentWidth: number,
	expanded: boolean,
): string[] {
	const axes = row.trust?.axes;
	const ordinary =
		axes !== undefined &&
		axes.artifactIntegrity === "verified" &&
		Object.values(axes).every((state) => !EXCEPTIONAL_TRUST_STATES.has(String(state)));
	const host =
		row.hostVerification === undefined ? "" : `${SEP}${theme.fg("body", `host checks ${row.hostVerification}`)}`;
	if (row.trust === undefined) {
		const unread = theme.fg(
			"annotation",
			!isTerminalStatus(row.status)
				? "not sealed yet"
				: row.status === "aborted" && row.progress === undefined
					? "nothing to judge: it never started"
					: "run record not read back",
		);
		return cardWrappedValueLines(theme, "trust", `${unread}${host}`, contentWidth);
	}
	// A run that failed or was stopped before any check ran has no verdict worth a reader's time beyond that fact;
	// the axes stay one Enter away.
	if (
		!expanded &&
		isTerminalStatus(row.status) &&
		row.status !== "completed" &&
		axes?.validationGrounding === "absent" &&
		row.validationFailure === undefined
	) {
		return cardWrappedValueLines(
			theme,
			"trust",
			`${theme.fg("annotation", "nothing was checked before it ended")}${host}`,
			contentWidth,
		);
	}
	// The verdict leads in plain words; the axes that back it follow as detail.
	const verdict = theme.fg(
		trustVerdictToken(row.trust.verdict),
		`${trustVerdictMark(row.trust.verdict)}${plainTrustVerdict(row.trust)}`,
	);
	// A failed validation names its validator and evidence right under the verdict, so a passing answer above it
	// never reads as a contradiction.
	const reason = row.reviewFindings !== undefined ? reviewFindingsWords(row.reviewFindings) : row.validationFailure;
	const why =
		reason === undefined
			? []
			: cardWrappedValueLines(
					theme,
					"why",
					`${theme.fg("body", reason)}${theme.fg("annotation", `${SEP}/view dispatch:${row.runId}`)}`,
					contentWidth,
				);
	const valueWidth = Math.max(1, contentWidth - CARD_KV_KEY_WIDTH - 1);
	const detail = ordinary
		? []
		: wrapTextWithAnsi(theme.fg("annotation", row.trust.text), valueWidth).map(
				(line) => `${" ".repeat(CARD_KV_KEY_WIDTH + 1)}${line}`,
			);
	return [...cardWrappedValueLines(theme, "trust", `${verdict}${host}`, contentWidth), ...why, ...detail];
}

/**
 * The selected run's facts under the board's table, most useful first: what it
 * is doing, then the task, the route, its telemetry and its provenance. The
 * board cuts this at its row budget, so the order is the priority. The run id
 * and elapsed time sit in the rule above, not in the body.
 */
export function dispatchCardBody(
	row: DispatchBoardRow,
	contentWidth: number,
	evidence?: RunEvidencePresentation,
	options: {
		expanded?: boolean;
		style?: OutputStyle;
		/** The key that opens detail on this row, because Enter opens the watch pane under a pane host. */
		detailKey?: string;
		endpointActive?: number;
		endpointQueued?: number;
		theme?: PancodeTheme;
	} = {},
): string[] {
	const theme = options.theme ?? pancodeTheme();
	if (row.plan !== undefined) return planCardBody(theme, row, row.plan, contentWidth);
	const usage = dispatchUsageText(row.usage);
	const cost = usage.cost;
	// The card says what went wrong in plain words, folded or open; the receipt's own words are the record's, in /view.
	const detail = workerFailureHeadline(terminalDetail(row));

	const presentation = dispatchStatusPresentation(row.status, {
		...(row.status === "running" ? { tick: animationStep(Date.now()) } : {}),
	});
	// The function phase is orange, while identity, cost and TTFT keep their own roles.
	const failure = completedRunFailure(row);
	const failureMark = completedRunMark(failure);
	const statusStr =
		failure !== null
			? theme.fg(failureMark.token, `${failureMark.glyph} ${presentation.label}${SEP}${failure.words}`)
			: `${theme.fg(presentation.glyphToken ?? presentation.token, presentation.glyph)} ${theme.fg(presentation.token, presentation.label)}`;

	// How long the model took to its first output, in words: a run that has not answered yet says so, and one that
	// never reached its model says nothing rather than `n/a`.
	const firstOutput =
		row.ttft !== undefined && row.ttft !== null
			? `first output after ${row.ttft}`
			: row.status === "running"
				? "no output yet"
				: null;

	// A queued run has produced nothing yet, so it never carries a throughput.
	const rate = wallTokenRate(row, usage);
	// Figures keep their lower-bound mark and the line states its coverage once, as its last unit, rather than a
	// `(N calls unknown)` after every figure. A figure nothing measured reads `not measured`, never `?`.
	const figure = (display: string): string => compactQuantity(display) ?? USAGE_NOT_MEASURED;
	const lineFigure = (key: "prompt" | "output" | "total", display: string): string =>
		boundMark(row.usage.kind === "ready" ? usageLineFigure(row.usage[key]) : figure(display));
	const tokenDisplays = [usage.prompt, usage.output, usage.total];
	const nothingMeasured = tokenDisplays.every((display) => compactQuantity(display) === null);
	const coverage =
		row.usage.kind === "unavailable" || row.usage.kind === "pending"
			? null
			: usageLineCoverage([
					{ label: "prompt", quantity: row.usage.prompt },
					{ label: "out", quantity: row.usage.output },
				]);
	const tokenUnits = nothingMeasured
		? [theme.fg("body", row.status === "running" || row.status === "enqueued" ? "not measured yet" : USAGE_NOT_MEASURED)]
		: [
				// Label-first words, as the turn receipt says them: `prompt 321 · out 12 · total 333`. The whole prompt,
				// cached reads included, is `prompt`; `in` is the uncached input on every surface (bt-11).
				theme.fg("body", `prompt ${lineFigure("prompt", usage.prompt)}`),
				theme.fg(
					"body",
					`out ${lineFigure("output", usage.output)}${rate !== null ? (options.expanded === true ? ` (${rate}/s wall avg)` : ` ${rate}/s`) : ""}`,
				),
				theme.fg("body", `total ${lineFigure("total", usage.total)}`),
			];

	// The model id is user data and can outrun the card; mark the cut with `…`
	// rather than hard-clipping it mid-token into a string that reads whole.
	const targetKey = cardKvKey(theme, "target");
	// The route is the target and model. Enter adds how the worker reached it only when that is not the ordinary model
	// call, because `http runtime` is a transport name that tells a person nothing they can act on.
	const routeLabel = formatTargetLabel(row.targetId, row.wireModelId, { abbreviate: false });
	const reach = RUNTIME_REACH_WORDS[row.runtimeKind];
	const route = options.expanded === true && reach !== undefined ? `${routeLabel}${dotSep(theme)}${reach}` : routeLabel;
	const targetLine = `${targetKey}${theme.fg("footerIdentity", fitIdentityLabel(route, Math.max(1, contentWidth - visibleWidth(targetKey))))}`;
	// Fleet facts: node placement (absent means local), gate role badge, and
	// reroute lineage. Whole units so overflow drops a fact, never clips one.
	const statusUnits = [
		statusStr,
		// A run on this machine is the default and says nothing; one placed on another node names it.
		...(row.node === undefined || row.node === "local" ? [] : [theme.fg("body", `on node ${row.node}`)]),
		...(row.endpoint !== undefined
			? [
					theme.fg(
						"info",
						`slots ${options.endpointActive ?? 0}/${row.endpoint.limit}${(options.endpointQueued ?? 0) > 0 ? ` +${options.endpointQueued} queued` : ""} ${row.endpoint.label}`,
					),
				]
			: []),
		...(row.gate !== undefined ? [theme.fg("info", `gate ${row.gate.role} c${row.gate.cycle}`)] : []),
		...(row.rerouteCount !== undefined && row.rerouteCount > 0
			? [theme.fg("warning", `rerouted x${row.rerouteCount}`)]
			: []),
		...(row.failoverHops !== undefined && row.failoverHops > 0
			? [theme.fg("warning", `failed over x${row.failoverHops}`)]
			: []),
		...(firstOutput === null ? [] : [theme.fg("body", firstOutput)]),
		...(cost === GLYPH.none
			? []
			: [theme.fg("body", cost === USAGE_NOT_MEASURED ? "cost not measured" : `cost ${cost}`)]),
	];
	// Context occupancy is a figure like the others: a lower bound keeps its mark, and one nothing measured is left out,
	// since the line's own coverage unit already says calls went unreported.
	const contextFigure = usageFigure(row.telemetry?.activity.contextTokens);
	const contextUnit = usageSaysNothing(contextFigure) ? null : theme.fg("body", `context ${boundMark(contextFigure)}`);
	// The phase column: a fleet step says which wave it belongs to and which
	// step it is; every other run leaves the cell empty rather than inventing a
	// position, so the column reads as "not a fleet step" and not as wave zero.
	const phaseCell =
		row.phase === undefined
			? null
			: truncateToWidth(
					`${row.phase.stepId}${SEP}wave ${row.phase.wave + 1} of its plan`,
					Math.max(1, contentWidth),
					GLYPH.ellipsis,
					false,
				);
	const fullTask = row.taskSummary
		? cardWrappedValueLines(theme, "task", theme.fg("body", row.taskSummary), contentWidth)
		: [];
	const minimal = options.style !== undefined && !tierPolicy(options.style).evidence && options.expanded !== true;
	const taskLines = minimal
		? fullTask.slice(0, 1).map((line) => (fullTask.length > 1 ? cutRowWithEllipsis(line, contentWidth) : line))
		: options.expanded === true || fullTask.length <= 3
			? fullTask
			: [
					...fullTask.slice(0, 2),
					theme.fg("annotation", `${GLYPH.ellipsis} ${options.detailKey ?? "Enter"} detail for full task`),
				];
	const started = runOriginWords(row);
	const bodyLines = [
		cardUnitsLine(theme, "status", statusUnits, contentWidth),
		...(minimal || (started === null && row.earlier !== true)
			? []
			: [
					cardUnitsLine(
						theme,
						"started",
						[
							...(started === null ? [] : [theme.fg("body", started)]),
							...(row.earlier === true ? [theme.fg("annotation", "recorded before this PanCode started")] : []),
						],
						contentWidth,
					),
				]),
	];
	// One current-operation row is useful at a glance; prose and policy expand on demand.
	if (row.progress) {
		const doing = progressActionLine(theme, row.progress, contentWidth, row.routeFirstOutput ?? null);
		if (doing !== null) bodyLines.push(doing);
		if (options.expanded === true)
			bodyLines.push(...progressAnswerLines(theme, row.progress, row.runId, contentWidth, row));
	}
	// Live tool activity: the executing tool (worker telemetry carries names,
	// never arguments, across the stdout seam) and the recent-tool trail.
	const currentTool = row.currentTool ?? null;
	const recentTools = row.recentTools ?? [];
	if (!row.progress && (currentTool !== null || recentTools.length > 0)) {
		const toolUnits = [
			currentTool !== null ? theme.fg("body", `${currentTool} running`) : theme.fg("annotation", "idle"),
			...(recentTools.length > 0 ? [theme.fg("body", `recent ${recentTools.join(" ")}`)] : []),
		];
		bodyLines.push(cardUnitsLine(theme, "tools", toolUnits, contentWidth));
	}
	if (row.status === "enqueued" && row.endpoint !== undefined) {
		const active = options.endpointActive ?? 0;
		const label = sanitizeCallTargetText(row.endpoint.label);
		bodyLines.push(
			...cardWrappedValueLines(
				theme,
				"waiting",
				theme.fg(
					"body",
					// The main turn's stream counts and is not gated, so `in use` can pass the
					// limit, and one settling then does not free a slot. The fold keeps the count and Enter explains it.
					options.expanded === true
						? `for a slot on ${label}: ${active} in use against a limit of ${row.endpoint.limit}, the main turn included. It starts once the count is under the limit.`
						: `for a slot on ${label}: ${active} in use, limit ${row.endpoint.limit}`,
				),
				contentWidth,
			),
		);
	}
	if (row.status === "enqueued" && row.endpoint === undefined) {
		bodyLines.push(
			...cardWrappedValueLines(
				theme,
				"waiting",
				// The fold leaves `[x] cancel` to the rail below it.
				theme.fg(
					"body",
					options.expanded === true
						? "for a worker slot. It starts when a running worker finishes, or [x] cancels it."
						: "until a worker slot frees",
				),
				contentWidth,
			),
		);
	}
	if (row.retry) {
		bodyLines.push(
			cardUnitsLine(
				theme,
				"retry",
				[
					theme.fg("warning", `attempt ${row.retry.attempt}`),
					theme.fg("body", retryCountdown(row.retry)),
					...(row.retry.reason.length > 0 ? [theme.fg("body", row.retry.reason)] : []),
				],
				contentWidth,
			),
		);
	}
	if (detail !== null)
		bodyLines.push(...cardWrappedValueLines(theme, "detail", theme.fg("annotation", detail), contentWidth));
	bodyLines.push(
		...taskLines,
		...(!minimal
			? [
					...(phaseCell === null ? [] : [cardUnitsLine(theme, "step", [theme.fg("info", phaseCell)], contentWidth)]),
					...(options.expanded === true
						? cardWrappedValueLines(theme, "target", theme.fg("body", route), contentWidth)
						: [targetLine]),
					cardUnitsLine(
						theme,
						"tokens",
						[
							...tokenUnits,
							...(contextUnit !== null ? [contextUnit] : []),
							...(coverage !== null && !nothingMeasured ? [theme.fg("annotation", coverage)] : []),
						],
						contentWidth,
					),
				]
			: []),
		...trustCardLines(theme, row, contentWidth, options.expanded === true),
	);
	if (row.steerAcknowledgement) {
		bodyLines.push(
			cardUnitsLine(
				theme,
				"control",
				[
					// The worker took the message; whether its model read it before the run ended is the transcript receipt's.
					// A settled run's row cannot tell whether its model read the message; the transcript receipt says which.
					theme.fg(
						"success",
						isTerminalStatus(row.status)
							? `${GLYPH.ok} the worker took your message before the run ended`
							: `${GLYPH.ok} the worker took your message`,
					),
					theme.fg("body", `${row.steerAcknowledgement.chars} chars`),
				],
				contentWidth,
			),
		);
	}
	if (row.writeRecordDowngrade) {
		// The provider's call id (`toolu_…`) matches nothing the TUI lists, so the card names the call by its tool and run.
		const warning = describeWriteBoundaryAttributionDowngrade({
			...row.writeRecordDowngrade,
			toolCallId: null,
			runId: row.runId,
			stepId: row.phase?.stepId ?? null,
		});
		// The rule is for the expanded card; the fold says only that the changed-files list may be short.
		const brief = `changed-files list may be incomplete: ${sanitizeCallTargetText(row.writeRecordDowngrade.tool)} can write paths it does not name`;
		bodyLines.push(
			...cardWrappedValueLines(
				theme,
				"record",
				theme.fg("warning", options.expanded === true ? `open: ${warning}` : brief),
				contentWidth,
			),
		);
	}
	// The proof row is present only when the telemetry projection knows an
	// evidence state for this run; an unknown/none state adds no line.
	if (evidence) {
		const proofLine = evidenceCardLine(theme, evidence, contentWidth);
		if (proofLine !== null) bodyLines.push(proofLine);
	}
	if (options.expanded === true && row.budget !== undefined) {
		bodyLines.push(
			...cardWrappedValueLines(theme, "limit", theme.fg("body", budgetLimitWords(row.budget)), contentWidth),
		);
	}
	return bodyLines;
}
