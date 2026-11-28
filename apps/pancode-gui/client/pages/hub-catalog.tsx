// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { routes } from "../../contracts/runtime-routes.js";
import type { Client } from "../api/client.js";
import { ProblemAlert, reportProblem } from "../design/notifications.js";
import { StatusMark } from "../design/status.js";
import { Dialog } from "../interaction/Dialog.js";
import { searchWith } from "../shell/use-search-draft.js";
import {
	applyLabel,
	catalogFacets,
	catalogKind,
	catalogKinds,
	catalogView,
	desktopManaged,
	TERMINAL_NOTE,
	terminalSteps,
} from "./hub-extension-model.js";
import {
	type Applied,
	componentSentence,
	copyOperations,
	copyState,
	diskSentence,
	effectSentence,
	missingScopes,
	needsRequirements,
	type Operation,
	originSentence,
	outcomeHeadline,
	type Package,
	type Plan,
	type Scope,
	scopeCopy,
	stepTitle,
	verb,
} from "./hub-plan.js";
import "./hub.css";

type Request = { operation: Operation; ref: string; scope: Scope; withRequirements?: boolean };

function PlanReview({ plan }: { plan: Plan }) {
	return (
		<ol className="hub-steps">
			{plan.steps.map((step) => (
				<li key={`${step.identity.scope}:${step.identity.ref}`}>
					<h3>{stepTitle(step)}</h3>
					{step.refusal && (
						<p className="hub-refusal" role="alert">
							PanCode refuses this step: {step.refusal}
						</p>
					)}
					<p>{effectSentence(step)}</p>
					<dl className="hub-facts">
						<div>
							<dt>Writes to</dt>
							<dd>
								<code>{step.destination}</code>
							</dd>
						</div>
						{step.source && (
							<div>
								<dt>Source</dt>
								<dd>
									<code>{step.source.sourceUrl}</code>
									{step.source.sha256 && (
										<small>
											{step.source.staged ? "Staged and verified" : "Not fetched"} · sha256 {step.source.sha256.slice(0, 16)}…
										</small>
									)}
								</dd>
							</div>
						)}
						{step.content && (
							<div>
								<dt>Contains</dt>
								<dd>
									{step.content.resources.length
										? step.content.resources
												.map((item) => `${item.kind} ${item.name}${item.valid ? "" : " (invalid)"}`)
												.join(", ")
										: "No components"}
									{!step.content.valid && <small>The pack did not validate.</small>}
								</dd>
							</div>
						)}
						{!!step.dependencies.requires.length && (
							<div>
								<dt>Requires</dt>
								<dd>
									{step.dependencies.requires.join(", ")}
									{!!step.dependencies.missing.length && <small>Not installed: {step.dependencies.missing.join(", ")}</small>}
									{!!step.dependencies.inactive.length && (
										<small>Installed but inactive: {step.dependencies.inactive.join(", ")}</small>
									)}
								</dd>
							</div>
						)}
						{!!step.dependents.preexisting.length && (
							<div>
								<dt>Already affected</dt>
								<dd>
									{step.dependents.preexisting
										.map((item) => `${item.ref} (${item.scope}): ${item.missing.join(", ")}`)
										.join("; ")}
								</dd>
							</div>
						)}
						{!!step.dependents.newlyBroken.length && (
							<div>
								<dt>Would break</dt>
								<dd>
									{step.dependents.newlyBroken
										.map((item) => `${item.ref} (${item.scope}): ${item.missing.join(", ")}`)
										.join("; ")}
								</dd>
							</div>
						)}
						<div>
							<dt>Recovery</dt>
							<dd>{step.recovery}</dd>
						</div>
					</dl>
					{!!step.content?.diagnostics.length && (
						<details>
							<summary>
								{step.content.diagnostics.length} validation {step.content.diagnostics.length === 1 ? "note" : "notes"}
							</summary>
							<ul>
								{step.content.diagnostics.map((note) => (
									<li key={note}>{note}</li>
								))}
							</ul>
						</details>
					)}
				</li>
			))}
		</ol>
	);
}

function Outcomes({ applied }: { applied: Applied }) {
	return (
		<>
			<ol className="hub-steps">
				{applied.outcomes.map((outcome) => {
					const headline = outcomeHeadline(outcome);
					return (
						<li key={`${outcome.identity.scope}:${outcome.identity.ref}`}>
							<StatusMark tone={headline.tone} label={outcome.status} />
							<h3>{headline.text}</h3>
							{outcome.error && (
								<p className="hub-refusal" role="alert">
									{outcome.error.message} {outcome.error.next}
								</p>
							)}
							{outcome.status === "committed" && (
								<dl className="hub-facts">
									<div>
										<dt>On disk</dt>
										<dd>{diskSentence(outcome)}</dd>
									</div>
									<div>
										<dt>Components</dt>
										<dd>{componentSentence(outcome)}</dd>
									</div>
									{outcome.recovery?.packageBackup && (
										<div>
											<dt>Backup kept</dt>
											<dd>
												<code>{outcome.recovery.packageBackup}</code>
											</dd>
										</div>
									)}
								</dl>
							)}
						</li>
					);
				})}
			</ol>
			{applied.committed > 0 && <RefreshNote refresh={applied.refresh} />}
		</>
	);
}

/** Whether the project's open conversations picked the change up, said as it happened. */
function RefreshNote({ refresh }: { refresh: Applied["refresh"] }) {
	if (refresh.status === "refreshed")
		return (
			<p className="hub-session-note hub-session-note--settled" role="status">
				<strong>
					{refresh.sessions === 1 ? "The open conversation reloaded" : `All ${refresh.sessions} open conversations reloaded`}{" "}
					its packs.
				</strong>{" "}
				Its next request uses the change.
			</p>
		);
	if (refresh.status === "failed")
		return (
			<p className="hub-session-note" role="alert">
				<strong>
					{refresh.failedSessions} of {refresh.sessions} open {refresh.sessions === 1 ? "conversation" : "conversations"} did
					not reload.
				</strong>{" "}
				{refresh.error}. The change is installed; run <code>/reload hub</code> there, or start a new conversation, to use
				it.
			</p>
		);
	return (
		<p className="hub-session-note hub-session-note--settled">
			<strong>No open conversation needed a reload.</strong> {refresh.reason}
		</p>
	);
}

function PlanDialog({
	client,
	workspaceId,
	request,
	onClose,
}: {
	client: Client;
	workspaceId: string | null;
	request: Request;
	onClose: () => void;
}) {
	const queries = useQueryClient();
	const cancel = useRef<HTMLButtonElement>(null);
	const applyKey = useRef(crypto.randomUUID());
	const [plan, setPlan] = useState<Plan | null>(null);
	const started = useRef(false),
		mounted = useRef(true),
		heldPlan = useRef<Plan | null>(null),
		writing = useRef(false);
	const release = useCallback(
		(planId: string) =>
			workspaceId
				? client.call(routes.hubPlanRelease, { params: { id: workspaceId, planId }, query: {}, body: {} })
				: client.call(routes.installationHubPlanRelease, { params: { planId }, query: {}, body: {} }),
		[client, workspaceId],
	);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			// A browser navigation can remove the dialog even while its source is staging.
			// Defer one microtask so StrictMode's temporary cleanup can remount first.
			queueMicrotask(() => {
				if (!mounted.current && heldPlan.current && !writing.current)
					void release(heldPlan.current.id).catch(reportProblem);
			});
		};
	}, [release]);
	const planning = useMutation({
		meta: { errorSurface: "inline" },
		mutationFn: (input: Request) =>
			workspaceId
				? client.call(routes.hubPlan, { params: { id: workspaceId }, query: {}, body: input })
				: client.call(routes.installationHubPlan, { params: {}, query: {}, body: input }),
		onSuccess: (value) => {
			heldPlan.current = value;
			if (mounted.current) setPlan(value);
			else void release(value.id).catch(reportProblem);
		},
	});
	const applying = useMutation({
		meta: { errorSurface: "inline" },
		mutationFn: async (planId: string) => {
			writing.current = true;
			try {
				const result = workspaceId
					? await client.call(
							routes.hubPlanApply,
							{ params: { id: workspaceId, planId }, query: {}, body: {} },
							applyKey.current,
						)
					: await client.call(
							routes.installationHubPlanApply,
							{ params: { planId }, query: {}, body: {} },
							applyKey.current,
						);
				heldPlan.current = null;
				return result;
			} finally {
				writing.current = false;
			}
		},
		onSettled: () => {
			for (const key of ["hub", "hub-agents", "hub-extensions"]) void queries.invalidateQueries({ queryKey: [key] });
		},
	});
	const plan0 = planning.mutate;
	useEffect(() => {
		// The ref survives StrictMode's double effect, so one dialog stages exactly one plan.
		if (started.current) return;
		started.current = true;
		plan0(request);
	}, [plan0, request]);
	const releasing = useMutation({
		meta: { errorSurface: "inline" },
		mutationFn: async (planId: string) => {
			const result = await release(planId);
			heldPlan.current = null;
			return result;
		},
	});
	const busy = planning.isPending || applying.isPending || releasing.isPending;
	useEffect(() => {
		const button = cancel.current;
		const dialog = button?.closest<HTMLElement>(".dialog");
		if (!button || !dialog) return;
		// Staging disables Cancel after it received initial focus. Keep keyboard focus in the review.
		if (!dialog.contains(document.activeElement)) {
			if (busy) dialog.focus();
			else button.focus();
		} else if (!busy && document.activeElement === dialog) button.focus();
	}, [busy]);
	const close = () => {
		// Keep the review open until staging or writes settle, and report failed release so it can be retried.
		if (busy) return;
		if (plan && !applying.data) releasing.mutate(plan.id, { onSuccess: onClose });
		else onClose();
	};
	const title = `${verb(request.operation)} ${request.ref}`;
	return (
		<Dialog
			title={title}
			eyebrow={applying.data ? "Hub · what happened" : "Hub · review before applying"}
			size="wide"
			onClose={close}
			initialFocus={cancel}
		>
			{planning.isPending && (
				<p role="status">Staging the source and checking what would change. Nothing is written yet.</p>
			)}
			{planning.error && (
				<>
					<ProblemAlert error={planning.error} />
					<button type="button" disabled={busy} onClick={() => planning.mutate(request)}>
						Retry planning
					</button>
				</>
			)}
			{plan && !applying.data && (
				<>
					<div className="hub-plan-summary">
						<StatusMark
							tone={plan.applicable ? "neutral" : "fail"}
							label={plan.applicable ? "Ready for review" : "Plan refused"}
						/>
						<span>
							{plan.steps.length} {plan.steps.length === 1 ? "step" : "steps"} · expires{" "}
							{new Date(plan.expiresAt).toLocaleTimeString()}
						</span>
					</div>
					<p>
						{plan.applicable
							? "This is exactly what will be applied. Nothing has been written yet."
							: "PanCode will not apply this plan. Nothing has been written."}
					</p>
					<PlanReview plan={plan} />
					{!!plan.diagnostics.length && (
						<details>
							<summary>
								{plan.diagnostics.length} planning {plan.diagnostics.length === 1 ? "note" : "notes"}
							</summary>
							<ul>
								{plan.diagnostics.map((note) => (
									<li key={note}>{note}</li>
								))}
							</ul>
						</details>
					)}
				</>
			)}
			{applying.isPending && <p role="status">Applying the reviewed plan. Keep this review open for the result.</p>}
			{releasing.isPending && <p role="status">Releasing staged sources…</p>}
			{releasing.error && <ProblemAlert error={releasing.error} />}
			{applying.error && (
				<>
					<ProblemAlert error={applying.error} />
					<p className="panel-note">
						The outcome could not be confirmed. Retrying sends the same apply request so an accepted change is not applied
						twice.
					</p>
				</>
			)}
			{applying.data && <Outcomes applied={applying.data} />}
			<div className="actions">
				{plan && !applying.data && plan.applicable && (
					<button type="button" className="primary" disabled={busy} onClick={() => applying.mutate(plan.id)}>
						{applyLabel(plan.steps.length, applying.isPending)}
					</button>
				)}
				{plan && !applying.data && needsRequirements(plan) && (
					<button
						type="button"
						className="primary"
						disabled={busy}
						onClick={() =>
							releasing.mutate(plan.id, {
								onSuccess: () => {
									setPlan(null);
									planning.mutate({ ...request, withRequirements: true });
								},
							})
						}
					>
						Plan again with its requirements
					</button>
				)}
				<button type="button" ref={cancel} disabled={busy} onClick={close}>
					{applying.data ? "Done" : "Cancel"}
				</button>
			</div>
		</Dialog>
	);
}

export function HubCatalog({
	client,
	workspaceId,
	packages,
	filter,
	compact = false,
	onReview,
}: {
	client: Client;
	/** `null` plans against the installation: user copies only. */
	workspaceId: string | null;
	packages: Package[];
	filter: string;
	compact?: boolean;
	onReview?: (() => void) | undefined;
}) {
	const detailId = useId();
	const [search, setSearch] = useSearchParams();
	const [localDiscovery, setLocalDiscovery] = useState<Record<string, string>>({});
	const valueFor = (key: string) => (compact ? localDiscovery[key] : search.get(key));
	const kinds = catalogKinds(packages);
	const kind = catalogKind(kinds, valueFor("kind"));
	const installedOnly = valueFor("installed") === "true",
		selected = valueFor("package");
	const discover = (key: string, value: string | null) => {
		if (compact) {
			setLocalDiscovery((current) => {
				const next = { ...current };
				if (value) next[key] = value;
				else delete next[key];
				return next;
			});
			return;
		}
		setSearch((current) => searchWith(current, key, value));
	};
	const [limit, setLimit] = useState(40),
		[request, setRequest] = useState<Request | null>(null);
	const review = (input: Request) => {
		// Release a native navigation dialog's top layer before the review claims focus.
		onReview?.();
		setRequest(input);
	};
	const { visible, installed, displayed, selectionHidden } = catalogView(packages, {
		kind,
		installedOnly,
		filter,
		selected,
		limit,
	});
	return (
		<>
			<fieldset className="hub-facets">
				<legend>Show</legend>
				{catalogFacets(packages, kinds).map((facet) => (
					<button
						type="button"
						key={facet.name}
						aria-pressed={kind === facet.name}
						onClick={() => {
							discover("kind", facet.name === "all" ? null : facet.name);
							setLimit(40);
						}}
					>
						{facet.label} · {facet.count}
					</button>
				))}
				<button
					type="button"
					aria-pressed={installedOnly}
					onClick={() => {
						discover("installed", installedOnly ? null : "true");
						setLimit(40);
					}}
				>
					Installed only · {installed}
				</button>
				{(kind !== "all" || installedOnly) && (
					<button
						type="button"
						onClick={() => {
							if (compact)
								setLocalDiscovery((current) => {
									const next = { ...current };
									delete next.kind;
									delete next.installed;
									return next;
								});
							else
								setSearch((current) => {
									const next = new URLSearchParams(current);
									next.delete("kind");
									next.delete("installed");
									return next;
								});
						}}
					>
						Clear pack filters
					</button>
				)}
			</fieldset>
			{!visible.length && (
				<p>{packages.length ? "No packs match." : "No catalog is configured and nothing is installed."}</p>
			)}
			<p className="hub-result-count" role="status">
				{visible.length} of {packages.length} packs · {installed} installed
			</p>
			{selectionHidden && (
				<p className="panel-note">
					The selected pack is outside these filters or is no longer available.{" "}
					<button type="button" onClick={() => discover("package", null)}>
						Clear selection
					</button>
				</p>
			)}
			<ul className="hub-packages">
				{displayed.map((pkg) => (
					<li key={pkg.ref} aria-label={pkg.ref} data-selected={selected === pkg.ref}>
						<div className="hub-package__identity">
							<h3>
								{pkg.name}
								{pkg.version && <span className="version">{pkg.version}</span>}
							</h3>
							<p title={pkg.description || undefined}>{pkg.description || "No description."}</p>
							<small>
								{pkg.kind} · {originSentence(pkg)}
								{pkg.requires?.length ? ` · requires ${pkg.requires.join(", ")}` : ""}
							</small>
							{pkg.refusal && (
								<p className="hub-refusal" title={pkg.refusal}>
									{pkg.refusal}
								</p>
							)}
							<button
								type="button"
								className="hub-inspect"
								aria-expanded={selected === pkg.ref}
								aria-controls={selected === pkg.ref ? `${detailId}-${pkg.ref}` : undefined}
								onClick={() => discover("package", selected === pkg.ref ? null : pkg.ref)}
							>
								{selected === pkg.ref ? "Close pack details" : `Inspect ${pkg.name}`}
							</button>
						</div>
						{(!compact || selected === pkg.ref) && (
							<div className="hub-package__copies">
								{!pkg.copies.length && <StatusMark tone="neutral" label="Not installed" />}
								{pkg.copies.map((copy) => {
									const state = copyState(String(copy.state));
									const scope = copy.scope as Scope;
									return (
										<div className="hub-copy" key={scope}>
											<span>
												{scopeCopy(scope)} <StatusMark tone={state.tone} label={state.label} />
											</span>
											{desktopManaged(pkg) && (
												<span className="hub-copy__actions">
													{copyOperations(String(copy.state)).map((operation) => (
														<button
															type="button"
															key={operation}
															aria-label={`${verb(operation)} the ${scope} copy of ${pkg.ref}`}
															onClick={() => review({ operation, ref: pkg.ref, scope })}
														>
															{verb(operation)}
														</button>
													))}
												</span>
											)}
										</div>
									);
								})}
								{pkg.kind === "extension" && (
									<details className="hub-terminal">
										<summary>Manage extension in the terminal</summary>
										<p className="panel-note">{TERMINAL_NOTE}</p>
										<ul>
											{terminalSteps(pkg).map((step) => (
												<li key={step.command}>
													{step.label}: <code>{step.command}</code>
												</li>
											))}
										</ul>
									</details>
								)}
								{desktopManaged(pkg) && pkg.catalogOrigin !== "installed" && (
									<span className="hub-copy__actions">
										{missingScopes(pkg, workspaceId !== null).map((scope) => (
											<button
												type="button"
												key={scope}
												className={pkg.copies.length ? undefined : scope === "user" ? "primary" : undefined}
												aria-label={`Install ${pkg.ref} ${scope === "user" ? "for me" : "in this project"}`}
												onClick={() => review({ operation: "install", ref: pkg.ref, scope })}
											>
												{scope === "user" ? "Install for me" : "Install in this project"}
											</button>
										))}
									</span>
								)}
							</div>
						)}
						{selected === pkg.ref && (
							<div className="hub-package__detail" id={`${detailId}-${pkg.ref}`}>
								<p>{pkg.description || "No pack description supplied."}</p>
								<h4>Pack source & requirements</h4>
								<dl className="hub-facts">
									<div>
										<dt>Reference</dt>
										<dd>
											<code>{pkg.ref}</code>
										</dd>
									</div>
									<div>
										<dt>Source</dt>
										<dd>
											<code>{pkg.sourceUrl}</code>
										</dd>
									</div>
									<div>
										<dt>Origin</dt>
										<dd>{originSentence(pkg)}</dd>
									</div>
									<div>
										<dt>Requires</dt>
										<dd>{pkg.requires?.length ? pkg.requires.join(", ") : "No declared requirements"}</dd>
									</div>
									<div>
										<dt>Provides</dt>
										<dd>
											{pkg.provides?.length
												? pkg.provides.map((item) => `${String(item.kind)} ${String(item.name)}`).join(", ")
												: "No components declared in the catalog"}
										</dd>
									</div>
									{pkg.sha256 && (
										<div>
											<dt>Fingerprint</dt>
											<dd>
												<code>{pkg.sha256}</code>
											</dd>
										</div>
									)}
								</dl>
								{desktopManaged(pkg) && (
									<p className="panel-note">
										Choose a destination to review the exact files, dependencies and effects before applying a change.
									</p>
								)}
							</div>
						)}
					</li>
				))}
			</ul>
			{visible.length > limit && (
				<button type="button" onClick={() => setLimit(limit + 40)}>
					Show more packs
				</button>
			)}
			{request && (
				<PlanDialog
					key={`${request.operation}:${request.scope}:${request.ref}`}
					client={client}
					workspaceId={workspaceId}
					request={request}
					onClose={() => setRequest(null)}
				/>
			)}
		</>
	);
}
