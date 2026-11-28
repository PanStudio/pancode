import type { ExtensionRunDigest } from "pancode/sdk/extension";

/** 2: entries repeat (`repetition`), and each carries the run's `completion` and `verification` from its run_end. */
export const CAMPAIGN_SCHEMA_VERSION = 2;

/** One roster entry: the target, model and thinking level one run uses, and the label naming its row and directory. */
export interface RosterEntry {
	target: string;
	model: string;
	thinking: string | null;
	label: string;
}

export interface CampaignProbe {
	extension: string;
	command: string;
}

export type CampaignAutonomy = "default" | "yolo";

/**
 * How an entry's run ended: `completed` exited 0, `unscripted` stopped on a question the answers file did not
 * script, `timed-out` hit `--timeout`, `failed` exited otherwise, `canceled` was stopped by the operator or never
 * started, and `error` could not be set up or launched.
 */
export type CampaignEntryStatus = "completed" | "unscripted" | "timed-out" | "failed" | "canceled" | "error";

export interface CampaignProbeResult {
	extension: string;
	command: string;
	exitCode: number | null;
	/** The command's text result, clipped. */
	text: string | null;
	data: unknown;
	error: string | null;
}

/** The completion the run's host sealed (its run_end `completion`): the agent's `finish` claim and the assessment. */
export interface CampaignEntryCompletion {
	/** Null when the agent declared nothing through `finish`. */
	claimed: "done" | "partly_done" | "not_done" | null;
	assessed: "done" | "partly_done" | "not_done" | "unknown";
	/** The open obligations that lowered the claim, such as `failed_check` or `unvalidated_mutation`. */
	facts: string[];
}

/** The host's verdict on the run from its run_end: outcome, cause codes and the `--verify` checks' states. */
export interface CampaignEntryVerification {
	outcome: string;
	outcomeDetail: string | null;
	causes: string[];
	checks: Array<{ command: string; status: string }>;
}

export interface CampaignEntryResult {
	schemaVersion: number;
	/** The entry's roster position, from 0. */
	index: number;
	/** Which pass over the roster this run is, from 0. */
	repetition: number;
	label: string;
	target: string;
	model: string;
	thinking: string | null;
	status: CampaignEntryStatus;
	exitCode: number | null;
	startedAt: string | null;
	/** Wall time of the run, from its start to its end; reported, never a pass criterion. */
	wallMs: number | null;
	dir: string;
	metrics: ExtensionRunDigest;
	/** Null when the run wrote no run_end, or one without a completion. */
	completion: CampaignEntryCompletion | null;
	/** Null when the run wrote no run_end. */
	verification: CampaignEntryVerification | null;
	desk: CampaignProbeResult | null;
	error: string | null;
}

export interface CampaignResult {
	schemaVersion: number;
	fixture: string;
	answers: string;
	prompt: string;
	out: string;
	/** Each entry's run timeout: `--timeout`, else the longest the runs service allows. */
	timeoutSeconds: number;
	repeat: number;
	autonomy: CampaignAutonomy;
	startedAt: string;
	completedAt: string;
	canceled: boolean;
	entries: CampaignEntryResult[];
}

/** What `campaign run` runs, its inputs checked and read. */
export interface CampaignInput {
	/** The seeded project every entry starts from; it is copied, never written. */
	fixture: string;
	roster: ReadonlyArray<RosterEntry>;
	/** The `run --answers` file, by name, as the document reports it. */
	answersFile: string;
	/** Its text, already checked by the runs service. */
	answers: string;
	prompt: string;
	/** Absent or empty; every entry's project copy, home, logs and entry.json land under it. */
	out: string;
	repeat: number;
	timeoutSeconds: number;
	autonomy: CampaignAutonomy;
	probe: CampaignProbe | null;
}

/** A digest with nothing in it: an entry whose run never started, or whose digest could not be read. */
export function emptyDigest(): ExtensionRunDigest {
	return {
		sessionId: null,
		gates: { reached: [], interviews: 0, answered: 0, unscripted: 0, unanswered: 0 },
		refusals: { hookBlocks: 0, toolRefusals: 0 },
		loopGuardBlocks: 0,
		tokens: null,
	};
}
