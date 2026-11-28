// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { workspaceCapabilitySignals } from "../store/index.js";

export type CapabilityKind = "skills" | "capabilities" | "agents";

export interface CapabilityCandidate {
	readonly id: string;
	readonly description: string;
	readonly triggers?: ReadonlyArray<string>;
}

export interface CapabilityRequest {
	readonly kind: CapabilityKind;
	readonly task: string;
	readonly workspace?: string;
	readonly candidates: ReadonlyArray<CapabilityCandidate>;
	/**
	 * Candidates that shape the corpus statistics and the coverage ceiling but are
	 * never returned: the tools already attached. Coverage stays measured against
	 * the best tool the session has, not only the ones a hint may name, so moving
	 * a tool onto the attached surface does not inflate the rest.
	 */
	readonly background?: ReadonlyArray<CapabilityCandidate>;
	readonly limit?: number;
	/** Candidate ids the workspace itself points at; they are kept and named whatever the task's words. */
	readonly signalled?: ReadonlyArray<string>;
}

/** The session's tools split into those a hint may name and the attached ones that only shape coverage. */
export function capabilityCorpus<Spec extends { name: string; description: string }>(
	specs: ReadonlyArray<Spec>,
	nameable: (spec: Spec) => boolean,
): Required<Pick<CapabilityRequest, "candidates" | "background">> {
	const entry = (spec: Spec): CapabilityCandidate => ({ id: spec.name, description: spec.description });
	return {
		candidates: specs.filter((spec) => nameable(spec)).map(entry),
		background: specs.filter((spec) => !nameable(spec)).map(entry),
	};
}

export interface CapabilityMatch extends CapabilityCandidate {
	readonly score: number;
	/** Task score as a fraction of the best any candidate could reach for this query, 0..1. */
	readonly coverage?: number;
	/** Kept because the workspace points at it, not for the task's words. */
	readonly workspaceSignal?: true;
}

export interface CapabilityGate {
	rank(request: CapabilityRequest): ReadonlyArray<CapabilityMatch>;
	used(kind: CapabilityKind, id: string): void;
}

// Calibrated on gateway rankings: unrelated workspace tasks top out near 0.51, a
// PanCode target question reaches 0.58 for pancode_docs, a parquet summary 0.87 for data.
const REMINDER_MIN_COVERAGE = 0.55;
const PANCODE_SCOPED_CAPABILITIES = new Set(["pancode_docs", "pancode_hub", "configure_pancode", "report"]);
const PANCODE_SCOPE = /\b(?:pancode(?:[\s-]coder)?|settings?|targets?|fleet|skills?|playbooks?)\b/iu;

/**
 * A ranked capability earns a per-turn hint only on a strong match, and PanCode's own
 * capabilities only when the message is about PanCode, its settings, targets,
 * fleet, skills or playbooks; a workspace question never routes to them.
 */
export function capabilityWorthNaming(match: CapabilityMatch, task: string): boolean {
	if (match.workspaceSignal && !PANCODE_SCOPED_CAPABILITIES.has(match.id)) return true;
	if ((match.coverage ?? 0) < REMINDER_MIN_COVERAGE) return false;
	return !PANCODE_SCOPED_CAPABILITIES.has(match.id) || PANCODE_SCOPE.test(task);
}

/**
 * A ready skill is offered on its own declared purpose, not on a shared word: candidate-relative coverage is 1.0 for a
 * lone installed skill, so `tdd` was offered for any edit that mentioned a test, the model loaded it, and its tool list
 * narrowed an ordinary change (R2-F11). An offer needs the operator's words to name the skill or reach two thirds of
 * the terms of one of its triggers. A skill that declares no triggers keeps the lexical ranking alone: `triggers` is
 * PanCode's field, so a skill in the plain Agent Skills format would otherwise be offered only when the operator already
 * spelled its id, and every hub skill declares triggers.
 */
export function skillWorthOffering(match: CapabilityMatch, task: string): boolean {
	const said = new Set(terms(task));
	const named = terms(match.id);
	if (named.length > 0 && named.every((term) => said.has(term))) return true;
	const triggers = match.triggers ?? [];
	if (triggers.length === 0) return true;
	return triggers.some((trigger) => {
		const words = [...new Set(terms(trigger))];
		const reached = words.filter((term) => said.has(term)).length;
		return words.length > 0 && reached >= Math.ceil((words.length * 2) / 3);
	});
}

const STOP = new Set(
	"a an the and or to of in on for from with by at as is are was be been being it its this that these those i me my we our you your can could would should please help want need use using skill skills task work do does not only when then than into about through have has had will some any how what".split(
		" ",
	),
);

function terms(text: string): string[] {
	return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
		.filter((word) => word.length > 1 && !STOP.has(word))
		.map((word) => (word.length > 5 ? word.replace(/(?:ing|ed|es|s)$/u, "") : word));
}

/** BM25 with weighted name/trigger fields and a bounded usage prior. No task-specific routing rules. */
function rankCapabilitiesLexically(
	request: CapabilityRequest,
	history: ReadonlyMap<string, number> = new Map(),
): CapabilityMatch[] {
	const query = [...new Set(terms(request.task.slice(0, 8000)))];
	if (query.length === 0) return [];
	const facts = new Set(terms(request.workspace?.slice(0, 2000) ?? ""));
	const docs = [...request.candidates, ...(request.background ?? [])].map((candidate) => {
		const words = terms(`${candidate.id} ${candidate.description} ${(candidate.triggers ?? []).join(" ")}`);
		const weights = new Map<string, number>();
		for (const [text, weight] of [
			[candidate.description, 1],
			[(candidate.triggers ?? []).join(" "), 2],
			[candidate.id, 3],
		] as const) {
			for (const term of terms(text)) weights.set(term, (weights.get(term) ?? 0) + weight);
		}
		return { candidate, words, weights };
	});
	const df = new Map<string, number>();
	for (const doc of docs) for (const term of doc.weights.keys()) df.set(term, (df.get(term) ?? 0) + 1);
	const average = docs.reduce((sum, doc) => sum + doc.words.length, 0) / Math.max(1, docs.length);
	const idf = (term: string): number =>
		Math.log(1 + (docs.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
	const scorers = docs.map(({ words, weights }) => (term: string): number => {
		const tf = weights.get(term) ?? 0;
		return (idf(term) * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * words.length) / Math.max(1, average)));
	});
	// The best possible task score: every query term at its strongest match in any candidate.
	const ceiling = query.reduce((sum, term) => sum + Math.max(0, ...scorers.map((bm25) => bm25(term))), 0);
	return docs
		.flatMap(({ candidate }, index) => {
			if (index >= request.candidates.length) return [];
			const bm25 = scorers[index] as (term: string) => number;
			const taskScore = query.reduce((sum, term) => sum + bm25(term), 0);
			if (taskScore <= 0) return [];
			const workspaceScore = [...facts].reduce((sum, term) => sum + bm25(term), 0);
			const prior = Math.min(0.1, Math.log1p(history.get(candidate.id) ?? 0) * 0.025);
			const score = taskScore * (1 + prior) + Math.min(taskScore * 0.15, workspaceScore * 0.1);
			return [{ ...candidate, score, coverage: taskScore / Math.max(Number.EPSILON, ceiling) }];
		})
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export interface CapabilityGateOptions {
	/** The workspace whose project store a capability ranking consults; the process cwd by default. */
	readonly cwd?: () => string;
}

/**
 * One session-owned gate: synchronous lexical advice with a bounded usage prior.
 * A capability ranking keeps what the workspace itself points at (a project store
 * holding a tag keeps store and data) unless the request names its own signals.
 */
export function createCapabilityGate(options: CapabilityGateOptions = {}): CapabilityGate {
	const history = new Map<CapabilityKind, Map<string, number>>();
	const cwd = options.cwd ?? (() => process.cwd());
	return {
		used(kind, id) {
			const counts = history.get(kind) ?? new Map<string, number>();
			counts.set(id, Math.min(100, (counts.get(id) ?? 0) + 1));
			history.set(kind, counts);
		},
		rank(request) {
			const lexical = rankCapabilitiesLexically(request, history.get(request.kind));
			const limit = Math.max(0, Math.min(10, request.limit ?? 5));
			const best = lexical[0]?.score ?? 0;
			const ranked = lexical
				.filter((hit) => hit.score >= best * 0.22)
				.map((hit) => ({ ...hit, score: hit.score / Math.max(1, best) }))
				.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
			const signalled = new Set(
				request.signalled ?? (request.kind === "capabilities" ? workspaceCapabilitySignals(cwd()) : []),
			);
			if (signalled.size === 0) return ranked.slice(0, limit);
			// A signalled candidate keeps its own rank when the task reached it and holds a place within the limit when not.
			const kept = request.candidates
				.filter((candidate) => signalled.has(candidate.id))
				.slice(0, limit)
				.map((candidate): CapabilityMatch => {
					const hit = ranked.find((match) => match.id === candidate.id);
					return { ...(hit ?? { ...candidate, score: 0, coverage: 0 }), workspaceSignal: true };
				});
			return [...ranked.filter((hit) => !signalled.has(hit.id)).slice(0, limit - kept.length), ...kept].sort(
				(a, b) => b.score - a.score || a.id.localeCompare(b.id),
			);
		},
	};
}
