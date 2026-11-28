// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link } from "react-router";
import type { UsagePerformance } from "../../contracts/reports.js";
import { routes } from "../../contracts/runtime-routes.js";
import type { CostReportV1, Quantity } from "../../contracts/wire.js";
import type { Client } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { SESSION_HISTORY_FRESHNESS, sessionHistoryQuery, workspacesQuery } from "../api/queries.js";
import { useSessionOverview } from "../shell/sessions.js";
import { taskRows } from "../shell/shell-model.js";
import { Explained } from "../telemetry/Explained.js";
import { explainable, quantityParts, quantityText } from "../telemetry/quantity-model.js";
import type { ScopeTask } from "./metrics-scope-model.js";
import { metricsScopeNote, recordedSessionsLabel, sessionTitle } from "./metrics-scope-model.js";
import { rankedMetricGroups, sparkline } from "./operator-metrics-model.js";
import "./operator-metrics.css";

type Metric = { display: string; ref?: string; fact: Quantity["fact"] };
type SessionMetric = UsagePerformance["sessions"][number];

export function useOperatorMetrics(client: Client, workspace = "") {
	return useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["operator-metrics", workspace],
		queryFn: ({ signal }) =>
			client.call(
				routes.telemetryMetrics,
				{ params: {}, query: workspace ? { workspace } : {}, body: {} },
				undefined,
				signal,
			),
	});
}

/**
 * The tasks in scope with the titles the task list shows: one project's, or every project's when the scope is all of
 * them. Recorded metrics name sessions by these titles.
 */
export function useScopeTasks(client: Client, workspace: string) {
	const workspaces = useQuery({
		...workspacesQuery(client),
		enabled: !workspace,
	});
	const ids = workspace ? [workspace] : (workspaces.data ?? []).map((row) => row.id);
	const queries = useQueryClient();
	// One query over the scope's projects, each read through the shared per-project history cache. useQueries would
	// pull its observer into the eager framework chunk for this lazy page.
	const histories = useQuery({
		queryKey: ["session-history", { scope: ids }],
		queryFn: () => Promise.all(ids.map((id) => queries.fetchQuery(sessionHistoryQuery(client, id)).catch(() => []))),
		enabled: ids.length > 0,
		...SESSION_HISTORY_FRESHNESS,
		meta: { errorSurface: "inline" },
	});
	const sessions = useSessionOverview(client).data?.sessions ?? [];
	const tasks: ScopeTask[] = ids.flatMap((id, index) => taskRows(id, sessions, histories.data?.[index] ?? []));
	return { tasks, titles: new Map(tasks.map((task) => [task.id, task.title])) };
}

function Measure({ client, value, label }: { client: Client; value: Metric | undefined; label: string }) {
	return <Explained client={client} label={label} {...explainable(value, "not recorded")} />;
}

function MetricSparkline({ values, label }: { values: readonly (number | null)[]; label: string }) {
	const segments = sparkline(values);
	return segments.length ? (
		<svg className="operator-sparkline" viewBox="0 0 160 30" role="img" aria-label={label}>
			<title>{label}. Gaps mean unrecorded timing; each chart scales to its largest measured value.</title>
			{segments.map((segment) => (
				<g key={segment[0]?.x}>
					{segment.length > 1 ? <polyline points={segment.map(({ x, y }) => `${x},${y}`).join(" ")} /> : null}
					{segment.map(({ x, y }) => (
						<circle key={x} cx={x} cy={y} r="1.8" />
					))}
				</g>
			))}
		</svg>
	) : (
		<span className="operator-missing">No measured timing</span>
	);
}

function Share({ value }: { value: Metric | undefined }) {
	const amount = value ? quantityParts(value).exact : null;
	return (
		<span className={`operator-share${amount === null ? " operator-share--unknown" : ""}`}>
			<span aria-hidden="true">
				<i style={{ width: `${amount === null ? 0 : Math.min(100, Math.max(0, amount))}%` }} />
			</span>
			<span>{value ? quantityText(value) : "not recorded"}</span>
		</span>
	);
}

function ModelMetrics({ client, cost }: { client: Client; cost: readonly CostReportV1[] }) {
	const [by, setBy] = useState<"model" | "target">("model");
	const [search, setSearch] = useState("");
	const id = useId();
	const rows = rankedMetricGroups(
		cost.find((report) => report.groupBy === by),
		search,
	);
	return (
		<section className="operator-section" aria-labelledby={`${id}-routes`}>
			<header className="operator-heading">
				<h2 id={`${id}-routes`}>Tokens, cost & cache</h2>
				<fieldset className="operator-switch">
					<legend className="sr-only">Group recorded usage</legend>
					<button type="button" aria-pressed={by === "model"} onClick={() => setBy("model")}>
						Per model
					</button>
					<button type="button" aria-pressed={by === "target"} onClick={() => setBy("target")}>
						Per connection
					</button>
				</fieldset>
				<input
					type="search"
					aria-label="Find recorded model or connection"
					placeholder="Model or connection"
					value={search}
					maxLength={256}
					onChange={(event) => setSearch(event.target.value)}
				/>
			</header>
			{rows.length ? (
				// biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need focus to scroll the dense table.
				<section className="operator-scroll" aria-label={`Recorded usage by ${by}`} tabIndex={0}>
					<table className="operator-table">
						<thead>
							<tr>
								<th scope="col">{by === "model" ? "Connection / model" : "Connection"}</th>
								<th scope="col">Calls</th>
								<th scope="col">Input</th>
								<th scope="col">Output</th>
								<th scope="col">Cache read</th>
								<th scope="col">Cache write</th>
								<th scope="col">Total tokens</th>
								<th scope="col">USD</th>
								<th scope="col">Cache / prompt</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr key={row.key}>
									<th scope="row">{row.key}</th>
									<td data-label="Calls">
										<Measure client={client} value={row.calls} label={`${row.key} calls`} />
									</td>
									<td data-label="Input">
										<Measure client={client} value={row.tokenFields?.input} label={`${row.key} input tokens`} />
									</td>
									<td data-label="Output">
										<Measure client={client} value={row.tokenFields?.output} label={`${row.key} output tokens`} />
									</td>
									<td data-label="Cache read">
										<Measure client={client} value={row.tokenFields?.cacheRead} label={`${row.key} cache-read tokens`} />
									</td>
									<td data-label="Cache write">
										<Measure client={client} value={row.tokenFields?.cacheWrite} label={`${row.key} cache-write tokens`} />
									</td>
									<td data-label="Total tokens">
										<Measure client={client} value={row.tokens} label={`${row.key} total tokens`} />
									</td>
									<td data-label="USD">
										<Measure client={client} value={row.usd} label={`${row.key} known USD`} />
									</td>
									<td data-label="Cache / prompt">
										<Share value={row.cacheShare} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
			) : (
				<p className="panel-empty">
					{search ? "No recorded route matches this search." : "No model or connection calls in these records."}
				</p>
			)}
			<p className="operator-note">
				Session + worker calls. Model is reported when recorded, requested otherwise. Cache share = measured cache-read /
				prompt tokens, not saved cost. Token fields overlap; unknown is not zero.
			</p>
		</section>
	);
}

export function SessionMetricFigures({ row }: { row: SessionMetric }) {
	return (
		<dl className="operator-session-figures">
			<div>
				<dt>Tokens</dt>
				<dd>{quantityText(row.tokens)}</dd>
			</div>
			<div>
				<dt>USD</dt>
				<dd>{quantityText(row.usd)}</dd>
			</div>
			<div>
				<dt>Cache / prompt</dt>
				<dd>{quantityText(row.cacheShare)}</dd>
			</div>
			<div>
				<dt>TTFT p50</dt>
				<dd>{quantityText(row.ttft.p50)}</dd>
			</div>
			<div>
				<dt>Tools / errors</dt>
				<dd>
					{quantityText(row.toolCalls)} / {quantityText(row.toolErrors)}
				</dd>
			</div>
			<div>
				<dt>Compactions</dt>
				<dd>{quantityText(row.compactions)}</dd>
			</div>
			<div className="operator-session-trend">
				<dt>Last 32 main attempts · TTFT</dt>
				<dd>
					<MetricSparkline values={row.trend} label="Recorded main-attempt TTFT, chronological" />
				</dd>
			</div>
		</dl>
	);
}

function SessionTrends({
	client,
	performance,
	titles,
}: {
	client: Client;
	performance: UsagePerformance;
	titles: ReadonlyMap<string, string>;
}) {
	const id = useId();
	const rows = performance.sessions;
	return (
		<section className="operator-section" aria-labelledby={`${id}-sessions`}>
			<header className="operator-heading">
				<h2 id={`${id}-sessions`}>Latency over sessions</h2>
				<span>{recordedSessionsLabel(rows.length, performance.sessionCount)}</span>
			</header>
			<div className="operator-trends">
				<div>
					<span>Main TTFT · median per session</span>
					<MetricSparkline
						values={rows.map((row) => quantityParts(row.ttft.p50).exact)}
						label="Main TTFT median per session, chronological"
					/>
				</div>
				<div>
					<span>Main model span · median per session</span>
					<MetricSparkline
						values={rows.map((row) => quantityParts(row.modelTime.p50).exact)}
						label="Main model-span median per session, chronological"
					/>
				</div>
			</div>
			{rows.length ? (
				// biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need focus to scroll the dense table.
				<section className="operator-scroll" aria-label="Recorded session measurements" tabIndex={0}>
					<table className="operator-table">
						<thead>
							<tr>
								<th scope="col">Task · first record</th>
								<th scope="col">Calls</th>
								<th scope="col">Tokens</th>
								<th scope="col">USD</th>
								<th scope="col">Cache / prompt</th>
								<th scope="col">Main TTFT p50 / p95</th>
								<th scope="col">Measured / missing</th>
								<th scope="col">Model span p50</th>
								<th scope="col">Tools / errors</th>
								<th scope="col">Compactions</th>
							</tr>
						</thead>
						<tbody>
							{[...rows].reverse().map((row) => (
								<tr key={row.sessionId}>
									<th scope="row">
										<Link to={`/sessions/${row.sessionId}`}>{sessionTitle(row.sessionId, titles)}</Link>
										<small>{row.startedAt ? formatTime(row.startedAt) : "No record time"}</small>
										{!row.journal.present || row.journal.gapRecords || row.journal.skipped || row.journal.damaged ? (
											<small>Incomplete journal</small>
										) : null}
									</th>
									<td data-label="Calls">
										<Measure client={client} value={row.calls} label={`${sessionTitle(row.sessionId, titles)} calls`} />
									</td>
									<td data-label="Tokens">
										<Measure client={client} value={row.tokens} label={`${sessionTitle(row.sessionId, titles)} tokens`} />
									</td>
									<td data-label="USD">
										<Measure client={client} value={row.usd} label={`${sessionTitle(row.sessionId, titles)} USD`} />
									</td>
									<td data-label="Cache / prompt">
										<Share value={row.cacheShare} />
									</td>
									<td data-label="Main TTFT p50 / p95">
										{quantityText(row.ttft.p50)} / {quantityText(row.ttft.p95)}
									</td>
									<td data-label="Measured / missing">
										{quantityText(row.ttft.measured)} / {quantityText(row.ttft.missing)}
									</td>
									<td data-label="Model span p50">{quantityText(row.modelTime.p50)}</td>
									<td data-label="Tools / errors">
										{quantityText(row.toolCalls)} / {quantityText(row.toolErrors)}
									</td>
									<td data-label="Compactions">{quantityText(row.compactions)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
			) : (
				<p className="panel-empty">No session journals in this scope.</p>
			)}
			<p className="operator-note">
				Chronological measured main-call timings only; p95 uses nearest rank. Unknown attempts leave gaps, not zeroes.
				Session totals include workers; timings exclude them.
			</p>
		</section>
	);
}

function ToolMetrics({ performance }: { performance: UsagePerformance }) {
	const id = useId();
	return (
		<section className="operator-section" aria-labelledby={`${id}-tools`}>
			<header className="operator-heading">
				<h2 id={`${id}-tools`}>Tool reliability</h2>
				<span>Observed settlements · engine clock · approval waits excluded</span>
			</header>
			{performance.tools.length ? (
				// biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need focus to scroll the dense table.
				<section className="operator-scroll" aria-label="Recorded tool reliability" tabIndex={0}>
					<table className="operator-table operator-table--tools">
						<thead>
							<tr>
								<th scope="col">Tool</th>
								<th scope="col">Calls</th>
								<th scope="col">OK</th>
								<th scope="col">Errors</th>
								<th scope="col">Blocked</th>
								<th scope="col">OK / executed</th>
								<th scope="col">Duration p50</th>
								<th scope="col">p95</th>
								<th scope="col">Timed calls</th>
							</tr>
						</thead>
						<tbody>
							{performance.tools.map((row) => (
								<tr key={row.tool}>
									<th scope="row">{row.tool}</th>
									<td data-label="Calls">{quantityText(row.calls)}</td>
									<td data-label="OK">{quantityText(row.ok)}</td>
									<td data-label="Errors">{quantityText(row.errors)}</td>
									<td data-label="Blocked">{quantityText(row.blocked)}</td>
									<td data-label="OK / executed">
										<Share value={row.success} />
									</td>
									<td data-label="Duration p50">{quantityText(row.latency.p50)}</td>
									<td data-label="p95">{quantityText(row.latency.p95)}</td>
									<td data-label="Timed calls">{quantityText(row.latency.measured)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
			) : (
				<p className="panel-empty">No tool settlements recorded. No reliability rate is inferred.</p>
			)}
			<p className="operator-note">
				OK / (OK + errors). Blocked calls are separate, not execution failures. Observations cover main and worker journals
				once each.
			</p>
		</section>
	);
}

function CompactionMetrics({
	performance,
	titles,
}: {
	performance: UsagePerformance;
	titles: ReadonlyMap<string, string>;
}) {
	const id = useId();
	const outcomes = Object.entries(performance.compactionOutcomes);
	const total = quantityParts(performance.totals.compactions).exact;
	return (
		<section className="operator-section" aria-labelledby={`${id}-compactions`}>
			<header className="operator-heading">
				<h2 id={`${id}-compactions`}>Compactions</h2>
				<span>
					{quantityText(performance.totals.compactions)} observed{" "}
					{quantityParts(performance.totals.compactions).exact === 1 ? "settlement" : "settlements"}
				</span>
			</header>
			<div className="operator-compactions">
				{outcomes.map(([outcome, value]) => (
					<div key={outcome}>
						<span>{outcome}</span>
						<strong>{quantityText(value)}</strong>
						<span className="operator-compaction-bar" aria-hidden="true">
							<i style={{ width: `${total ? ((quantityParts(value).exact ?? 0) * 100) / total : 0}%` }} />
						</span>
					</div>
				))}
			</div>
			{performance.compactions.length ? (
				<details className="operator-records">
					<summary>Recent compaction records · {performance.compactions.length}</summary>
					<ol>
						{performance.compactions.map((row) => (
							<li key={row.recordId}>
								<time dateTime={row.at}>{formatTime(row.at)}</time>
								<strong>{row.outcome}</strong>
								{row.sessionId ? (
									<Link to={`/sessions/${row.sessionId}`}>{sessionTitle(row.sessionId, titles)}</Link>
								) : (
									<span>No session owner</span>
								)}
								{row.checkpointTurnId ? <small>Checkpoint {row.checkpointTurnId}</small> : null}
							</li>
						))}
					</ol>
				</details>
			) : null}
		</section>
	);
}

export function OperatorMetrics({
	client,
	performance,
	cost,
	workspace = "",
	session,
	compact = false,
}: {
	client: Client;
	performance: UsagePerformance;
	cost: readonly CostReportV1[];
	/** The project in scope; empty or absent for every project. */
	workspace?: string;
	/** The one task these metrics were read for, when they were. */
	session?: string;
	/** Records fold into a disclosure, and in a narrow container each table row reads as a labelled stack. */
	compact?: boolean;
}) {
	const { tasks, titles } = useScopeTasks(client, workspace);
	const scope = metricsScopeNote({
		recorded: performance.sessions.map((row) => row.sessionId),
		recordedCount: performance.sessionCount,
		tasks,
		project: !!workspace,
		...(session !== undefined ? { session } : {}),
	});
	const sections = (
		<>
			<ModelMetrics client={client} cost={cost} />
			<SessionTrends client={client} performance={performance} titles={titles} />
			<ToolMetrics performance={performance} />
			<CompactionMetrics performance={performance} titles={titles} />
		</>
	);
	return (
		<div className="operator-metrics" data-compact={compact || undefined}>
			<dl className="operator-counters">
				{(
					[
						["Observed tool calls", performance.totals.toolCalls],
						["Tool errors", performance.totals.toolErrors],
						["Blocked calls", performance.totals.toolBlocked],
						["Compactions", performance.totals.compactions],
					] as const
				).map(([label, value]) => (
					<div key={label}>
						<dt>{label}</dt>
						<dd>{quantityText(value)}</dd>
					</div>
				))}
			</dl>
			{scope ? <p className="operator-note operator-scope">{scope}</p> : null}
			{performance.coverage.unavailable || performance.coverage.gaps ? (
				<p className="operator-coverage" role="status">
					Incomplete coverage: {performance.coverage.unavailable} session{" "}
					{performance.coverage.unavailable === 1 ? "record" : "records"} could not be read and {performance.coverage.gaps}{" "}
					{performance.coverage.gaps === 1 ? "entry was" : "entries were"} skipped, damaged or missing. These counters cover
					only what could be read.
				</p>
			) : null}
			{compact ? (
				<details className="operator-records">
					<summary>Recorded metrics · models, connections, session trends, tools & compactions</summary>
					{sections}
				</details>
			) : (
				sections
			)}
		</div>
	);
}

export function SessionDiagnostics({ client, sessionId }: { client: Client; sessionId: string }) {
	const query = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["telemetry", sessionId, "metrics"],
		queryFn: ({ signal }) =>
			client.call(routes.telemetrySessionMetrics, { params: { id: sessionId }, query: {}, body: {} }, undefined, signal),
	});
	return (
		<>
			{query.isPending ? <p role="status">Reading recorded session metrics…</p> : null}
			{query.error ? (
				<p role="alert">
					{query.error.message}{" "}
					<button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>
						Retry recorded metrics
					</button>
				</p>
			) : null}
			{query.data ? <OperatorMetrics client={client} {...query.data} session={sessionId} compact /> : null}
		</>
	);
}
