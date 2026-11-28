// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Campaign persistence under the pack's project data directory, `<repo>/.pancode/data/research/<id>/`: the immutable
 * `campaign.json`, the append-only `journal.jsonl` of typed events, and the raw `samples/<name>.json` every grade is
 * recomputed from. `root` is that data directory.
 */
import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	RESEARCH_CAMPAIGN_VERSION,
	type ResearchCampaign,
	type ResearchJournalEvent,
	type ResearchSamples,
} from "./types.ts";

const CAMPAIGN_ID = /^r[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/u;
const JOURNAL_TYPES = new Set<ResearchJournalEvent["type"]>([
	"opened",
	"aa",
	"iteration-started",
	"agent-finished",
	"committed",
	"measured",
	"graded",
	"ratcheted",
	"archived",
	"recorded",
	"stopped",
	"resumed",
]);

/** A run lock whose heartbeat is older than this belongs to a run that died holding it. */
export const STALE_LOCK_MS = 60_000;
const HEARTBEAT_MS = 15_000;

export function isResearchCampaignId(id: string): boolean {
	return CAMPAIGN_ID.test(id);
}

/** A sortable id: `r<yyyymmdd>-<hhmmss>-<4 hex>` in UTC. */
export function newResearchCampaignId(now: Date = new Date(), suffix: string = randomBytes(2).toString("hex")): string {
	const iso = now.toISOString();
	return `r${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}-${suffix}`;
}

export function campaignDir(root: string, id: string): string {
	if (!isResearchCampaignId(id)) throw new Error(`invalid research campaign id '${id}'`);
	return join(root, id);
}

export function samplesName(iteration: number | "aa"): string {
	return iteration === "aa" ? "aa" : `it-${String(iteration).padStart(4, "0")}`;
}

function fsyncDirectory(dir: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(dir, "r");
		fsyncSync(fd);
	} catch {
		// Some filesystems refuse a directory fsync; the rename already happened.
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Write through a temporary sibling, fsync and rename, so a reader never sees half a file. */
export function writeFileAtomic(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		const fd = openSync(temporary, "wx", 0o600);
		try {
			writeSync(fd, text);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
	fsyncDirectory(dirname(path));
}

/** Write `campaign.json` once; a second write for the same id is refused. */
export function writeCampaign(root: string, campaign: ResearchCampaign): string {
	const dir = campaignDir(root, campaign.id);
	const path = join(dir, "campaign.json");
	if (existsSync(path)) throw new Error(`research campaign ${campaign.id} already exists`);
	mkdirSync(join(dir, "samples"), { recursive: true });
	writeFileAtomic(path, `${JSON.stringify(campaign, null, 2)}\n`);
	return path;
}

export function readCampaign(root: string, id: string): ResearchCampaign {
	const path = join(campaignDir(root, id), "campaign.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`research campaign ${id} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		(parsed as { version?: unknown }).version !== RESEARCH_CAMPAIGN_VERSION ||
		(parsed as { id?: unknown }).id !== id
	)
		throw new Error(`research campaign ${id} has a campaign.json this build does not read`);
	return parsed as ResearchCampaign;
}

/** Append one event to the journal and fsync it, so a crash keeps every step that completed. */
export function appendJournal(root: string, id: string, event: ResearchJournalEvent): void {
	const dir = campaignDir(root, id);
	const path = join(dir, "journal.jsonl");
	const created = !existsSync(path);
	const fd = openSync(path, "a", 0o600);
	try {
		writeSync(fd, `${JSON.stringify(event)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	if (created) fsyncDirectory(dir);
}

export interface JournalRead {
	events: ResearchJournalEvent[];
	/** Lines that are not a known event, such as a line torn by a crash. */
	unreadable: number;
}

export function parseJournal(text: string): JournalRead {
	const events: ResearchJournalEvent[] = [];
	let unreadable = 0;
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const value = JSON.parse(line) as unknown;
			if (
				value !== null &&
				typeof value === "object" &&
				JOURNAL_TYPES.has((value as { type?: unknown }).type as ResearchJournalEvent["type"])
			)
				events.push(value as ResearchJournalEvent);
			else unreadable += 1;
		} catch {
			unreadable += 1;
		}
	}
	return { events, unreadable };
}

export function readJournal(root: string, id: string): JournalRead {
	const path = join(campaignDir(root, id), "journal.jsonl");
	if (!existsSync(path)) return { events: [], unreadable: 0 };
	return parseJournal(readFileSync(path, "utf8"));
}

export function writeSamples(root: string, id: string, samples: ResearchSamples): string {
	const name = `${samplesName(samples.iteration)}.json`;
	writeFileAtomic(join(campaignDir(root, id), "samples", name), `${JSON.stringify(samples, null, 2)}\n`);
	return `samples/${name}`;
}

export function readSamples(root: string, id: string, relative: string): ResearchSamples {
	if (!/^samples\/(aa|it-[0-9]{4,})\.json$/u.test(relative)) throw new Error(`invalid samples path '${relative}'`);
	return JSON.parse(readFileSync(join(campaignDir(root, id), relative), "utf8")) as ResearchSamples;
}

/** Campaign ids under the data directory, oldest first. */
export function listCampaignIds(root: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && isResearchCampaignId(entry.name))
		.map((entry) => entry.name)
		.filter((id) => existsSync(join(root, id, "campaign.json")))
		.sort();
}

export class CampaignBusyError extends Error {}

/**
 * Hold a campaign's run lock while `fn` runs: an exclusive `run.lock` whose mtime a heartbeat keeps fresh. A lock whose
 * heartbeat stopped for {@link STALE_LOCK_MS} belongs to a run that died and is taken over; a live one refuses.
 */
export async function withCampaignLock<T>(
	root: string,
	id: string,
	fn: () => Promise<T>,
	now: () => number = Date.now,
): Promise<T> {
	const path = join(campaignDir(root, id), "run.lock");
	const body = `${JSON.stringify({ pid: process.pid, since: new Date(now()).toISOString() })}\n`;
	const take = (): boolean => {
		try {
			writeFileSync(path, body, { flag: "wx", mode: 0o600 });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			return false;
		}
	};
	if (!take()) {
		let since = "an unknown time";
		let stale = false;
		try {
			stale = now() - statSync(path).mtimeMs >= STALE_LOCK_MS;
			const recorded = (JSON.parse(readFileSync(path, "utf8")) as { since?: unknown }).since;
			if (typeof recorded === "string") since = recorded;
		} catch {
			stale = !existsSync(path);
		}
		if (stale) rmSync(path, { force: true });
		if (!stale || !take())
			throw new CampaignBusyError(`campaign ${id} is already running (since ${since}); stop it first`);
	}
	const beat = setInterval(() => {
		try {
			const at = new Date(now());
			utimesSync(path, at, at);
		} catch {
			// The lock went away under the run; the next take by another run decides.
		}
	}, HEARTBEAT_MS);
	beat.unref();
	try {
		return await fn();
	} finally {
		clearInterval(beat);
		rmSync(path, { force: true });
	}
}
