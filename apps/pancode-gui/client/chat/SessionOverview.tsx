// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { routes } from "../../contracts/runtime-routes.js";
import type { Client } from "../api/client.js";
import { emptyInput } from "../api/client.js";
import { sessionBoardQuery, sessionTreeQuery, workspacesQuery } from "../api/queries.js";
import type { IconName } from "../design/icons.js";
import { Icon } from "../design/icons.js";
import { StatusMark } from "../design/status.js";
import { countRender } from "../render/render-probe.js";
import { PancodePulse, PULSE_SIZE } from "../shell/PancodeMark.js";
import { activeWork, isHeld, STATE_LABELS, taskTitle } from "../shell/shell-model.js";
import { Explained } from "../telemetry/Explained.js";
import { boardView, type PlanRow } from "./board-model.js";
import { branchView } from "./branch-model.js";
import { changeCounts, changeLine, summarizeChanges } from "./changes-model.js";
import { FLEET_STATE_LABELS, FLEET_STATE_TONES, fleetEvidence, foldFleetRuns, isLiveRun } from "./fleet-facts.js";
import { summarizeHealth } from "./health.js";
import {
	activityLine,
	agentsLine,
	boardLine,
	contextMeter,
	evidenceLine,
	findingsText,
	forkPointsLine,
	gitLine,
	healthSummary,
	moreSteps,
	taskOverview,
	taskStateWord,
	turnsLine,
} from "./overview-model.js";
import { ProjectTrustNotice } from "./ProjectTrustNotice.js";
import type { PaneSession, PaneView } from "./pane-model.js";
import { RunRecordLine } from "./RunRecordLine.js";
import type { RouteFacts } from "./route.js";
import { modelSessionFacts, sessionFacts } from "./session-facts-model.js";
import { useContextLedger, useSessionCapabilities, useSessionUsage, useTelemetrySession } from "./session-telemetry.js";
import { sessionSpend, settledTurns, spendLine } from "./session-usage-model.js";
import { livePlanView, planCancellation } from "./telemetry-model.js";

function PlanGlyph({ tone }: { tone: PlanRow["tone"] }) {
	if (tone === "success")
		return (
			<span className="pane-step__glyph is-done" aria-hidden="true">
				<Icon name="check" />
			</span>
		);
	// One moving mark per column: the Task state carries it, so a running step is a still glyph.
	if (tone === "running") return <span className="pane-step__glyph is-running" aria-hidden="true" />;
	if (tone === "fail" || tone === "warn") return <span className="pane-step__glyph is-blocked" aria-hidden="true" />;
	return <span className="pane-step__glyph" aria-hidden="true" />;
}

/** The target's reported health as one word beside the route. */
const ROUTE_HEALTH_WORDS: Readonly<Record<RouteFacts["tone"], string>> = {
	success: "Healthy",
	unverified: "Not checked",
	warn: "Degraded",
	fail: "Unavailable",
	running: "Checking",
	neutral: "Reported",
};

/** A section of the Session column. A section with more to show names itself as the way in. */
function Section({
	id,
	title,
	icon,
	aside,
	open,
	summary,
	expanded = false,
	children,
}: {
	id: string;
	title: string;
	icon: IconName;
	aside?: ReactNode;
	open?: () => void;
	summary?: string;
	expanded?: boolean;
	children: ReactNode;
}) {
	if (summary !== undefined)
		return (
			<details className="pane-card pane-card--disclosure" open={expanded}>
				<summary>
					<span className="pane-card__symbol">
						<Icon name={icon} />
					</span>
					<span id={id} className="pane-card__label">
						{title}
					</span>
					<span className="pane-card__summary">{summary}</span>
					<Icon name="chevronRight" />
				</summary>
				<div className="pane-card__body">
					{children}
					{open ? (
						<button type="button" className="pane-card__details" onClick={open}>
							Open {title.toLowerCase()}
							<Icon name="chevronRight" />
						</button>
					) : null}
				</div>
			</details>
		);
	return (
		<section className="pane-card" aria-labelledby={id}>
			<header>
				<h2 id={id} className="pane-card__heading">
					{open ? (
						<button type="button" className="pane-card__open" onClick={open}>
							<span className="pane-card__symbol">
								<Icon name={icon} />
							</span>
							<span>{title}</span>
							<span className="pane-card__chevron">
								<Icon name="chevronRight" />
							</span>
						</button>
					) : (
						<>
							<span className="pane-card__symbol">
								<Icon name={icon} />
							</span>
							{title}
						</>
					)}
				</h2>
				{aside}
			</header>
			{children}
		</section>
	);
}

/**
 * Everything about the open chat, top to bottom: how it is going, how full the window is, what it has
 * used, the plan, what changed, who is helping. Nothing here is measured by the browser; each line is
 * a value the session reported, and each section opens the view that says the rest.
 */
export function SessionOverview({
	active = true,
	client,
	session,
	title,
	workspaceRoot,
	nowMs,
	onOpen,
	onChangeModel,
	route,
}: {
	active?: boolean;
	client: Client;
	session: PaneSession;
	title: string;
	workspaceRoot: string | undefined;
	nowMs: number;
	onOpen: (view: PaneView) => void;
	/** Opens the place this task's route is changed: the composer's picker, or the saved route. */
	onChangeModel?: () => void;
	/** The route the composer shows, so the column and the chip never disagree. */
	route?: RouteFacts;
}) {
	countRender("session-overview");
	const [more, setMore] = useState(false);
	const open = session.state === "open";
	const sessions = useQuery({
		queryKey: ["sessions"],
		queryFn: () => client.call(routes.sessions, emptyInput),
		enabled: active && more,
	});
	const workspaces = useQuery({
		...workspacesQuery(client),
		enabled: active && more,
	});
	const workspaceNames = new Map((workspaces.data ?? []).map((item) => [item.id, item.name]));
	const work = activeWork((sessions.data ?? []).filter(isHeld));
	const activity = work.items;
	const otherActivity = activity.filter((item) => item.session.id !== session.id);
	const capabilities = useSessionCapabilities(client, session.id, active && open);
	const settled = settledTurns(session.turns);
	// The keys the drill-ins use, so opening one after the column costs no second request.
	const board = useQuery({
		...sessionBoardQuery(client, session.id, settled),
		enabled: active && open && !!capabilities.data?.board,
	});
	// The branches drill reads the same key, so its summary here costs no second request.
	const tree = useQuery({
		...sessionTreeQuery(client, session.id, settled),
		enabled: active && more && open && !!capabilities.data?.branches,
	});
	const branches = tree.data ? branchView(tree.data) : null;
	const tip = branches?.rows.filter((row) => row.tip && row.active).at(-1) ?? null;
	const ledger = useContextLedger(client, session.id, settled, active && more && open && !!capabilities.data?.context);
	const usage = useSessionUsage(client, session.id, settled, active && more && open && !!capabilities.data?.telemetry);
	const view = board.data ? boardView(board.data) : null;
	const plan = session.telemetry?.plan ? livePlanView(session.telemetry.plan) : (view?.plan ?? null);
	const workspace = session.telemetry?.workspace;
	const facts = sessionFacts(session.notices, session.telemetry?.notices);
	const health = summarizeHealth(session.health);
	const meter = ledger.data ? contextMeter(ledger.data) : null;
	const segments = ledger.data?.display.segments ?? [];
	const overview = useMemo(() => taskOverview(session.turns, nowMs), [session.turns, nowMs]);
	const changes = useMemo(() => summarizeChanges(session.tools, workspaceRoot), [session.tools, workspaceRoot]);
	const runs = useMemo(() => foldFleetRuns(session.fleet), [session.fleet]);
	const evidence = useMemo(() => fleetEvidence(session.fleet), [session.fleet]);
	const live = runs.filter(isLiveRun);
	const records = runs.filter((run) => run.record);
	const working = open && (overview.running || !!session.contextWork?.active);
	const state = taskStateWord(session, overview.running);
	const done = plan?.rows.filter((row) => row.tone === "success").length ?? 0;
	const openTasks = view?.tasks.filter((task) => task.actions.length > 0).length ?? 0;
	const decisions = view?.activeDecisions.length ?? 0;
	const boardFacts = boardLine(openTasks, decisions);
	const changed = changeLine(changes);
	// A task that is not open has no usage read; the cold telemetry route folds its journal instead (#434).
	const cold = useTelemetrySession(client, session.id, active && more && !open);
	const spend = sessionSpend({
		usage: usage.data,
		live: overview.running || !usage.data || usage.isPlaceholderData ? session.telemetry?.usage : undefined,
		cold: cold.data,
	});
	const used = spendLine(spend);
	const healthSection =
		health.rows.length > 0 ? (
			<Section id="pane-health" title="Health" icon="shield" summary={healthSummary(health)} expanded={health.attention}>
				{health.rows.map((row) => (
					<p key={row.id} className="pane-card__facts">
						<StatusMark tone={row.tone} label={row.label} {...(row.detail ? { detail: row.detail } : {})} />
					</p>
				))}
			</Section>
		) : null;
	return (
		<div className="pane-cards">
			<section className="pane-card pane-card--lead" aria-labelledby="pane-goal">
				<header>
					<h2 id="pane-goal" className="pane-card__heading">
						<span className="pane-card__symbol">
							<Icon name="compose" />
						</span>
						Task
					</h2>
					<span className="pane-card__state" data-state={state}>
						{working ? <PancodePulse size={PULSE_SIZE.inline} /> : null}
						{state}
					</span>
				</header>
				<p className="pane-goal">{title}</p>
				{overview.turns > 0 ? <p className="pane-card__facts">{turnsLine(overview)}</p> : null}
			</section>
			{session.telemetry?.trust?.ignored.length ? (
				<Section id="pane-trust" title="Project trust" icon="shield">
					<ProjectTrustNotice
						client={client}
						sessionId={session.id}
						running={overview.running}
						trust={session.telemetry.trust}
					/>
				</Section>
			) : null}
			{health.attention ? healthSection : null}

			<Section
				id="pane-changes"
				title="Review changes"
				icon="fileDiff"
				open={() => onOpen("changes")}
				aside={
					changes.applied > 0 ? (
						<span className="diffstat">
							<span className="diffstat__add">+{changes.adds}</span> <span className="diffstat__del">−{changes.dels}</span>
						</span>
					) : null
				}
			>
				{changes.files.length > 0 ? (
					<p className="pane-changes-line">
						{changed.applied}
						<span className="sr-only">{changeCounts(changes)}</span>
						{changed.pending}
					</p>
				) : (
					<p className="pane-empty">No edits reported here yet.</p>
				)}
			</Section>

			{capabilities.data?.artifacts ? (
				<Section id="pane-artifacts" title="Task files" icon="artifacts" open={() => onOpen("artifacts")}>
					<p className="pane-empty">Browse files, outputs and task records.</p>
				</Section>
			) : null}
			<Section
				id="pane-plan"
				title="Tasks and decisions"
				icon="listChecks"
				{...(capabilities.data?.board ? { open: () => onOpen("board") } : {})}
				aside={
					plan && plan.rows.length > 0 ? (
						<span className="pane-card__state">
							{done}/{plan.rows.length}
						</span>
					) : null
				}
			>
				{plan && plan.rows.length > 0 ? (
					<ol className="pane-steps">
						{(capabilities.data?.board ? plan.rows.slice(0, 5) : plan.rows).map((row) => (
							<li key={row.id} data-tone={row.tone}>
								<PlanGlyph tone={row.tone} />
								<span className="sr-only">{row.word}: </span>
								<span>
									{row.title}
									{row.reason ? <small>{row.reason}</small> : null}
								</span>
							</li>
						))}
					</ol>
				) : (
					<p className="pane-empty">
						{capabilities.data?.board === undefined && !session.telemetry?.plan
							? "This session does not report a plan."
							: (planCancellation(session.telemetry?.plan) ?? "No plan published yet.")}
					</p>
				)}
				{plan && plan.rows.length > 0 && planCancellation(session.telemetry?.plan) ? (
					<p className="pane-card__facts">{planCancellation(session.telemetry?.plan)}</p>
				) : null}
				{capabilities.data?.board && plan && plan.rows.length > 5 ? (
					<p className="pane-card__facts">{moreSteps(plan.rows.length, 5)}</p>
				) : null}
				{boardFacts !== null ? <p className="pane-card__facts">{boardFacts}</p> : null}
			</Section>

			{session.telemetry?.plan?.truncated ? <p className="pane-hint">The plan shows its first 100 steps.</p> : null}
			{runs.length > 0 || capabilities.data?.fleet ? (
				<Section
					id="pane-agents"
					title="Agents"
					icon="fleet"
					{...(runs.length === 0 ? { summary: "None dispatched" } : {})}
					open={() => onOpen("agents")}
					aside={runs.length > 0 ? <span className="pane-card__state">{agentsLine(live.length, runs.length)}</span> : null}
				>
					{runs.length === 0 ? (
						<p className="pane-empty">No agents dispatched yet.</p>
					) : live.length > 0 ? (
						<ul className="pane-agents">
							{live.slice(0, 4).map((run) => (
								<li key={run.runId}>
									<strong>{run.agentId}</strong>
									<span>{run.taskPreview ?? "Task preview not reported"}</span>
									<StatusMark tone={FLEET_STATE_TONES[run.state]} label={FLEET_STATE_LABELS[run.state]} />
								</li>
							))}
						</ul>
					) : (
						<p className="pane-empty">Every worker has settled.</p>
					)}
				</Section>
			) : null}

			{evidence.length > 0 || records.length > 0 ? (
				<Section
					id="pane-evidence"
					title="Evidence"
					icon="evidence"
					aside={<span className="pane-card__state">{evidenceLine(records.length, evidence.length)}</span>}
				>
					{records
						.slice(-6)
						.reverse()
						.map((run) => (
							<div key={run.runId}>
								<strong className="pane-card__facts">{run.agentId}</strong>
								{run.record ? <RunRecordLine record={run.record} /> : null}
							</div>
						))}
					<ul className="pane-evidence">
						{evidence.slice(0, 6).map((row) => {
							const agent = runs.find((run) => run.runId === row.runId)?.agentId ?? "run";
							return (
								<li key={row.id}>
									<StatusMark
										tone={row.firstPassSuccess ? "success" : "warn"}
										label={row.firstPassSuccess ? "First pass" : "Retried"}
									/>
									<span>
										<strong>{agent}</strong> {findingsText(row.findingCount)}
									</span>
									<span className="pane-evidence__links">
										<Link to={`/evidence/${encodeURIComponent(row.runId)}`}>Evidence</Link>
										<Link to={`/fleet/dispatches/${encodeURIComponent(row.runId)}`}>Run</Link>
									</span>
								</li>
							);
						})}
					</ul>
				</Section>
			) : null}

			<details className="pane-more" open={more} onToggle={(event) => setMore(event.currentTarget.open)}>
				<summary>
					<Icon name="layers" />
					<span>
						<strong>More details</strong>
						<small>Model, context, usage and branches</small>
					</span>
					<Icon name="chevronRight" />
				</summary>
				{more ? (
					<div className="pane-more__body">
						{route ? (
							<Section
								id="pane-model"
								title="Model"
								icon="models"
								{...(onChangeModel ? { open: onChangeModel } : {})}
								aside={<StatusMark tone={route.tone} label={ROUTE_HEALTH_WORDS[route.tone]} />}
							>
								<p className="pane-changes-line" title={route.title}>
									<span className="pane-mono">{route.text}</span>
								</p>
								{route.thinking ? <p className="pane-card__facts">Thinking {route.thinking}</p> : null}
								{modelSessionFacts(route.config, facts.model).map((text) => (
									<p key={text} className="pane-card__facts">
										{text}
									</p>
								))}
							</Section>
						) : null}

						{meter || capabilities.data?.context || facts.context.length > 0 ? (
							<Section
								id="pane-context"
								title="Context"
								icon="layers"
								open={() => onOpen("context")}
								aside={meter?.figure ? <span className="pane-card__state">{meter.figure}</span> : null}
							>
								{meter ? (
									<div className="pane-meter" data-tone={meter.tone}>
										{/* biome-ignore lint/a11y/useSemanticElements: a native meter draws one fill; this one stacks the window's parts. */}
										<div
											className="pane-stack"
											role="meter"
											aria-label="Context window"
											aria-valuemin={0}
											aria-valuemax={100}
											aria-valuenow={meter.percent}
											aria-valuetext={meter.text}
										>
											{segments.map((segment, index) => (
												<span
													key={segment.key}
													className="pane-stack__part"
													data-index={index}
													style={{ width: `${segment.fill}%` }}
													title={`${segment.label} ${segment.share}`}
												/>
											))}
										</div>
										<p className="pane-card__facts">{meter.label}</p>
										{segments.length > 0 ? (
											<ul className="pane-legend" aria-label="What fills the window">
												{segments.map((segment, index) => (
													<li key={segment.key} data-index={index}>
														{segment.label} <span>{segment.share}</span>
													</li>
												))}
											</ul>
										) : null}
									</div>
								) : (
									<p className="pane-empty">{ledger.isPending ? "Reading the context window…" : "Not reported yet."}</p>
								)}
								{facts.context.map((text) => (
									<p key={text} className="pane-card__facts">
										{text}
									</p>
								))}
							</Section>
						) : null}

						{!health.attention ? healthSection : null}
						{facts.other.length > 0 ? (
							<Section id="pane-notes" title="Session notes" icon="sessions">
								{facts.other.map((text) => (
									<p key={text} className="pane-card__facts">
										{text}
									</p>
								))}
							</Section>
						) : null}

						<Section
							id="pane-usage"
							title="Usage"
							icon="usage"
							summary={used || "No usage reported"}
							{...(capabilities.data?.telemetry ? { open: () => onOpen("usage") } : {})}
						>
							{used ? (
								<dl className="pane-usage-stats">
									<div>
										<dt>Tokens</dt>
										<dd>
											<Explained
												client={client}
												label="Tokens"
												value={spend.tokens ?? "not recorded"}
												factRef={spend.refs.tokens}
											/>
										</dd>
									</div>
									<div>
										<dt>Cost</dt>
										<dd>
											<Explained client={client} label="Cost" value={spend.cost ?? "Unpriced"} factRef={spend.refs.cost} />
										</dd>
									</div>
								</dl>
							) : (
								<p className="pane-empty">No usage reported yet.</p>
							)}
						</Section>

						{branches || capabilities.data?.branches ? (
							<Section
								id="pane-branches"
								title="Branches"
								icon="branch"
								{...(branches?.branchPoints === 0 && !branches?.forkedFrom ? { summary: "Current branch" } : {})}
								open={() => onOpen("branches")}
								aside={
									(branches?.branchPoints ?? 0) > 0 ? (
										<span className="pane-card__state">{forkPointsLine(branches?.branchPoints ?? 0)}</span>
									) : null
								}
							>
								<p className="pane-changes-line">
									{!branches
										? "Read the conversation branches."
										: branches.branchPoints === 0
											? "One line of conversation."
											: "Continuing on the current branch."}
									{branches?.forkedFrom ? " Forked from an earlier task." : ""}
								</p>
								{tip ? <p className="pane-card__facts pane-card__preview">Latest: {tip.label ?? tip.text}</p> : null}
							</Section>
						) : null}

						<Section
							id="pane-activity"
							title="PanCode activity"
							icon="running"
							summary={sessions.data ? activityLine(work) : sessions.error ? "Unavailable" : "Loading…"}
							expanded={activity.length > 0 || !!sessions.error}
						>
							{sessions.data ? (
								<>
									<p className="pane-card__facts">{activityLine(work)}</p>
									{otherActivity.length > 0 ? (
										<ul className="pane-agents">
											{otherActivity.map((item) => (
												<li key={item.session.id}>
													<Icon name={item.state === "approval" ? "shield" : "sessions"} />
													<Link to={`/sessions/${item.session.id}`}>{taskTitle(item.session)}</Link>
													<span>
														{[workspaceNames.get(item.session.workspaceId), STATE_LABELS[item.state]].filter(Boolean).join(" · ")}
													</span>
												</li>
											))}
										</ul>
									) : (
										<p className="pane-empty">
											{activity.length > 0 ? "This is the only active session." : "No work is running or queued."}
										</p>
									)}
									<p className="pane-card__facts">Across all workspaces in PanCode.</p>
								</>
							) : (
								<p className="pane-empty">
									{sessions.error ? "PanCode activity could not be read." : "Reading PanCode activity…"}
								</p>
							)}
						</Section>

						{workspace ? (
							<Section id="pane-workspace" title="Workspace" icon="folder">
								<p className="pane-path" title={workspace.cwd}>
									<bdi dir="ltr">{workspace.cwd}</bdi>
								</p>
								<p className="pane-card__facts">{gitLine(workspace)}</p>
							</Section>
						) : null}
					</div>
				) : null}
			</details>
		</div>
	);
}
