// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { routes } from "../../contracts/runtime-routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { Facts } from "../design/facts.js";
import { PanelEmpty, PanelHeading } from "../design/panel.js";
import { emptyState, PANELS } from "../design/panel-model.js";
import { StatusMark } from "../design/status.js";
import { useRevealCurrent } from "../interaction/use-reveal-current.js";
import { liveSearchWith, useSearchDraft } from "../shell/use-search-draft.js";
import { HubCatalog } from "./hub-catalog.js";
import {
	type Agent,
	agentCard,
	collectionTabLabel,
	extensionState,
	hubContextCopy,
	matchesQuery,
	type Resource,
	resourceDetails,
	skillCard,
	tabAfterKey,
} from "./hub-model.js";
import { useWorkspaceSelection, WorkspacePicker } from "./workspace-selection.js";

const collections = ["Catalog", "Agents", "Skills", "Prompts", "Playbooks", "Extensions", "Verifiers"] as const;
type Collection = (typeof collections)[number];
type Entry = {
	id: string;
	name: string;
	description: string;
	state: string;
	detail: unknown;
	agent?: Agent;
	skill?: Resource;
};

function ResourceBody({ collection, value }: { collection: string; value: unknown }) {
	const detail = resourceDetails(collection, value);
	return (
		<>
			<p>{detail.explanation}</p>
			<CardFacts facts={detail.facts} />
			{!!detail.notes.length && (
				<ul>
					{detail.notes.map((note) => (
						<li key={note}>{note}</li>
					))}
				</ul>
			)}
			<details>
				<summary>Source and configuration</summary>
				<Facts
					value={value}
					order={["availability", "reason", "source", "owner", "origin", "path"]}
					hide={["key", "name", "description"]}
				/>
			</details>
		</>
	);
}

function CardFacts({ facts }: { facts: { label: string; value: string; absent?: true }[] }) {
	return (
		<dl className="facts">
			{facts.map((fact) => (
				<div className="fact" key={fact.label}>
					<dt>{fact.label}</dt>
					<dd data-tone={fact.absent ? "absent" : undefined}>{fact.value}</dd>
				</div>
			))}
		</dl>
	);
}

/** Capability, context tier, budget and reserve first; skills as chips; tool surfaces behind their count. */
function AgentBody({ agent }: { agent: Agent }) {
	const card = agentCard(agent);
	return (
		<>
			<CardFacts facts={card.facts} />
			{!!card.skills.length && (
				<div className="hub-bound">
					<span>Bound skills</span>
					<ul className="fact__chips">
						{card.skills.map((skill) => (
							<li key={skill}>{skill}</li>
						))}
					</ul>
				</div>
			)}
			<details>
				<summary>Declared tool surfaces · {card.tools.length}</summary>
				{card.tools.length ? (
					<ul className="fact__chips">
						{card.tools.map((tool) => (
							<li key={tool}>{tool}</li>
						))}
					</ul>
				) : (
					<PanelEmpty>This agent declares no tool surface.</PanelEmpty>
				)}
			</details>
			<p className="panel-note">{card.footer.join(" · ")}</p>
			<details>
				<summary>Source and configuration</summary>
				<Facts value={agent} hide={["id", "name", "description", "skills", "tools"]} />
			</details>
		</>
	);
}

/** The reach sentence leads, because whether the model can ever see a skill outranks every other fact. */
function SkillBody({ skill }: { skill: Resource }) {
	const card = skillCard(skill);
	return (
		<>
			<StatusMark tone={card.reachable ? "success" : "neutral"} label={card.mark} />
			<p>{card.reach}</p>
			{skill.reason && <p className="panel-note">{skill.reason}</p>}
			<CardFacts facts={card.facts} />
			<p className="panel-note">{card.footer.join(" · ")}</p>
			<details>
				<summary>Source and configuration</summary>
				<Facts
					value={skill}
					order={["availability", "reason", "source", "owner", "origin", "path"]}
					hide={["key", "name", "description"]}
				/>
			</details>
		</>
	);
}
const purpose: Record<Collection, string> = {
	Catalog:
		"Every pack PanCode can install, and every copy already installed, for you or for this project. Each change is planned first, shown to you, and only then applied.",
	Agents: "Specialists PanCode can assign work to. Their specifications describe the tools, skills and limits they use.",
	Skills: "Reusable instructions that guide PanCode through a task.",
	Prompts: "Saved starting points for conversations and common tasks.",
	Playbooks: "Saved workflows the fleet runs, coordinating several steps or specialists.",
	Extensions: "Installed packs that add executable capabilities. Admission state shows whether PanCode can load them.",
	Verifiers: "Checks PanCode discovered for this workspace. Viewing this list does not run them.",
};
export function HubPage({
	client,
	compact = false,
	workspaceId,
	onReview,
}: {
	client: Client;
	compact?: boolean;
	workspaceId?: string | undefined;
	onReview?: (() => void) | undefined;
}) {
	const selection = useWorkspaceSelection(client);
	const id = workspaceId ?? selection.id;
	const [search, setSearch] = useSearchParams();
	const [localDiscovery, setLocalDiscovery] = useState<{ collection: Collection; q: string }>({
		collection: "Catalog",
		q: "",
	});
	const active = compact
		? localDiscovery.collection
		: (collections.find((name) => name.toLowerCase() === search.get("collection")) ?? "Catalog");
	const filter = compact ? localDiscovery.q : (search.get("q") ?? "");
	const tabId = useId();
	const collectionBar = useRevealCurrent<HTMLDivElement>(active);
	const [limit, setLimit] = useState(40);
	const searchBox = useSearchDraft(filter, (query) => {
		setLimit(40);
		if (compact) {
			setLocalDiscovery((current) => ({ ...current, q: query }));
			return;
		}
		const next = liveSearchWith("q", query);
		next.set("collection", active.toLowerCase());
		setSearch(next, { replace: true });
	});
	const discover = (collection: Collection, query: string, replace = false) => {
		if (compact) {
			setLocalDiscovery({ collection, q: query });
			return;
		}
		setSearch(
			(current) => {
				const next = new URLSearchParams(current);
				next.set("collection", collection.toLowerCase());
				if (query) next.set("q", query);
				else next.delete("q");
				if (collection !== active) {
					next.delete("package");
					next.delete("kind");
					next.delete("installed");
				}
				return next;
			},
			{ replace },
		);
	};
	// With no workspace open the page reads installation-wide rather than waiting for one.
	const resolved = !!workspaceId || (!selection.workspaces.isPending && !selection.missing);
	const context = hubContextCopy(!!id);
	const inventory = useQuery({
		queryKey: ["hub", id],
		enabled: resolved,
		queryFn: () =>
			id ? client.call(routes.hub, { ...emptyInput, params: { id } }) : client.call(routes.installationHub, emptyInput),
	});
	const agents = useQuery({
		queryKey: ["hub-agents", id],
		enabled: resolved,
		queryFn: () =>
			id
				? client.call(routes.hubAgents, { ...emptyInput, params: { id } })
				: client.call(routes.installationHubAgents, emptyInput),
	});
	const extensions = useQuery({
		queryKey: ["hub-extensions", id],
		enabled: resolved,
		queryFn: () =>
			id
				? client.call(routes.hubExtensions, { ...emptyInput, params: { id } })
				: client.call(routes.installationHubExtensions, emptyInput),
	});
	const verifiers = useQuery({
		queryKey: ["hub-verifiers", id],
		enabled: !!id,
		queryFn: () => client.call(routes.hubVerifiers, { ...emptyInput, params: { id } }),
	});
	const resourceEntries = (kind: "skill" | "prompt" | "playbook"): Entry[] =>
		(inventory.data?.resources ?? [])
			.filter((row) => row.kind === kind)
			.map((row) => ({
				id: row.key,
				name: row.name,
				description: row.description,
				state: `${row.availability} · ${row.source.class}`,
				detail: row,
				...(kind === "skill" ? { skill: row } : {}),
			}));
	const entries: Record<Exclude<Collection, "Catalog">, Entry[]> = {
		Agents: (agents.data?.agents ?? []).map((row) => ({
			id: row.id,
			name: row.name,
			description: row.description,
			state: `${row.category} · ${row.source}`,
			detail: row,
			agent: row,
		})),
		Skills: resourceEntries("skill"),
		Prompts: resourceEntries("prompt"),
		Playbooks: resourceEntries("playbook"),
		Extensions: (extensions.data?.extensions ?? []).map((row) => ({
			id: `${row.id}:${row.scope}`,
			name: row.name,
			description: row.description,
			state: extensionState(row),
			detail: row,
		})),
		Verifiers: (verifiers.data?.checks ?? []).map((row) => ({
			id: row.id,
			name: row.id,
			description: row.description,
			state: `${row.origin} · ${row.runner}`,
			detail: row,
		})),
	};
	const source =
		active === "Agents" ? agents : active === "Extensions" ? extensions : active === "Verifiers" ? verifiers : inventory;
	// Free text runs across every string field a row carries, not only its name.
	const visible = (active === "Catalog" ? [] : entries[active]).filter((row) => matchesQuery(row.detail, filter));
	const tabs = useRef(new Map<Collection, HTMLButtonElement>());
	const activate = (name: Collection) => {
		discover(name, "");
		setLimit(40);
	};
	const onTabKey = (event: KeyboardEvent) => {
		const next = tabAfterKey(collections, active, event.key);
		if (!next) return;
		event.preventDefault();
		activate(next);
		tabs.current.get(next)?.focus();
	};
	const tabLabel = (name: Collection) => {
		const query =
			name === "Agents" ? agents : name === "Extensions" ? extensions : name === "Verifiers" ? verifiers : inventory;
		const count = !query.data ? undefined : name === "Catalog" ? inventory.data?.packages.length : entries[name].length;
		return collectionTabLabel(name, { read: name === "Verifiers" ? !!id : resolved, count, failed: query.isError });
	};
	return (
		<section className="hub-page">
			{!compact && <PanelHeading panel={PANELS.hub} level={1} />}
			{!workspaceId && <WorkspacePicker selection={selection} purpose="installation" />}
			{!compact && <p>{context.intro}</p>}
			<div ref={collectionBar} className="settings-tabs" role="tablist" aria-label="Hub collections" onKeyDown={onTabKey}>
				{collections.map((name) => (
					<button
						type="button"
						role="tab"
						key={name}
						id={`${tabId}-hub-tab-${name}`}
						aria-selected={active === name}
						aria-controls={`${tabId}-hub-panel`}
						// One tab stop for the whole list; the arrow keys move inside it.
						tabIndex={active === name ? 0 : -1}
						ref={(node) => {
							if (node) tabs.current.set(name, node);
							else tabs.current.delete(name);
						}}
						onClick={() => activate(name)}
					>
						{tabLabel(name)}
					</button>
				))}
			</div>
			<div role="tabpanel" id={`${tabId}-hub-panel`} aria-labelledby={`${tabId}-hub-tab-${active}`}>
				{!compact && <h2>{active}</h2>}
				{!compact && <p>{purpose[active]}</p>}
				<label className="settings-filter">
					Search {active.toLowerCase()}
					<input
						type="search"
						value={searchBox.value}
						onChange={searchBox.onChange}
						placeholder="Name, description or source"
					/>
				</label>
				{active === "Verifiers" && !id && resolved && (
					<PanelEmpty>Verifiers are the checks of one project. Open a project to discover its checks.</PanelEmpty>
				)}
				{source.isPending && (active === "Verifiers" ? !!id : resolved) && (
					<p role="status">Reading {active.toLowerCase()}…</p>
				)}
				{source.error && (
					<p role="alert">
						{source.error.message}{" "}
						<button type="button" onClick={() => void source.refetch()}>
							Try again
						</button>
					</p>
				)}
				{inventory.data && Object.values(inventory.data.truncated).some(Boolean) && (
					<PanelEmpty>
						This inventory is incomplete. Search and filters cover only the records returned by the server.
					</PanelEmpty>
				)}
				{active === "Verifiers" && verifiers.data && (
					<>
						{verifiers.data.discovery === "blocked" && (
							<p role="status">
								Check discovery is blocked: {verifiers.data.blockedBy}. {verifiers.data.rejection} {verifiers.data.rejectedAt}
							</p>
						)}
						{verifiers.data.checksTruncated && <PanelEmpty>{emptyState.bounded("checks", "Later")}</PanelEmpty>}
						{!!verifiers.data.diagnosticCount && (
							<p>
								{verifiers.data.diagnosticCount} discovery{" "}
								{verifiers.data.diagnosticCount === 1 ? "diagnostic was" : "diagnostics were"} reported.
							</p>
						)}
					</>
				)}
				{active === "Catalog" && inventory.data && (
					<HubCatalog
						key={id}
						client={client}
						workspaceId={id || null}
						packages={inventory.data.packages}
						filter={filter}
						compact={compact}
						onReview={onReview}
					/>
				)}
				{active !== "Catalog" && source.data && !visible.length && (
					<PanelEmpty>
						{filter ? (
							<>
								No matches. Try a different search.{" "}
								<button type="button" onClick={() => discover(active, "")}>
									Clear search
								</button>
							</>
						) : (
							emptyState.emptyStore(active.toLowerCase().replace(/s$/u, ""), context.where)
						)}
					</PanelEmpty>
				)}
				{active !== "Catalog" && source.data && (
					<p className="hub-result-count" role="status">
						{visible.length} of {entries[active].length} {active.toLowerCase()} · {context.inventory}
					</p>
				)}
				<div className="hub-resources" data-searching={filter ? "" : undefined}>
					{visible.slice(0, limit).map((row) => (
						<article className="hub-resource" key={row.id}>
							<div className="hub-resource__identity">
								<h3>{row.name}</h3>
								<p>{row.description}</p>
								<small>{row.state}</small>
							</div>
							<details className="hub-resource__details">
								<summary>Inspect {row.name}</summary>
								{row.agent ? (
									<AgentBody agent={row.agent} />
								) : row.skill ? (
									<SkillBody skill={row.skill} />
								) : (
									<ResourceBody collection={active} value={row.detail} />
								)}
							</details>
						</article>
					))}
				</div>
				{visible.length > limit && (
					<button type="button" onClick={() => setLimit(limit + 40)}>
						Show more {active.toLowerCase()}
					</button>
				)}
				{!!inventory.data?.diagnostics.length && (
					<details className="trace-panel">
						<summary>Hub discovery notes</summary>
						<ul>
							{inventory.data.diagnostics.map((message) => (
								<li key={message}>{message}</li>
							))}
						</ul>
					</details>
				)}
			</div>
		</section>
	);
}
