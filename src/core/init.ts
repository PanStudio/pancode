// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Bootstrap PanCode's config/data/state/cache directories on first install.
 * Creates the full directory tree required by subsequent domains and writes
 * defaults when absent. Idempotent.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDevVersion } from "./build-info.js";
import { SETTINGS_FILE_MODE, SETTINGS_SCAFFOLD_YAML } from "./defaults.js";
import { readPancodeVersion } from "./package-root.js";
import { safeResourceWrite } from "./safe-resource-write.js";
import { withStateFileLockSync } from "./state-file-lock.js";
import {
	assertPancodeDirLayout,
	pancodeCacheDir,
	pancodeConfigDir,
	pancodeDataDir,
	pancodeStateDir,
	resolvePancodeDirs,
} from "./xdg.js";

interface InitReport {
	configDir: string;
	dataDir: string;
	stateDir: string;
	cacheDir: string;
	createdPaths: string[];
	touchedSettings: boolean;
	/** Set when a newer PanCode last used this home; `home.json` was then left as it was. */
	newerHome?: NewerHome;
}

/** A home last written by a newer PanCode than the running one. */
export interface NewerHome {
	version: string;
}

const CONFIG_SUBDIRS = ["agents"] as const;
const DATA_SUBDIRS = ["memory"] as const;
const STATE_SUBDIRS = ["sessions", "interviews", "scratch"] as const;
// State directories that are only ever PanCode's and hold transcripts, tool output or run records.
// `memory` holds observations and history candidates drawn from transcripts.
const PRIVATE_STATE_SUBDIRS = [...STATE_SUBDIRS, "telemetry", "live", "runs", "fleet-runs", "memory"] as const;

interface InstallMetadata {
	version: string;
	/**
	 * When PanCode was first installed on this machine, present only when that is
	 * actually known. Absent on a record this process had to synthesize over a
	 * state root that already existed, where the install time is unrecoverable.
	 */
	installedAt?: string;
	upgradedAt?: string;
	/**
	 * When this record was rebuilt because it was missing or unreadable. A repair
	 * is not an install and must never be written into `installedAt`: `pancode
	 * doctor --fix` over a wiped state root reported the repair minute as the day
	 * the user installed PanCode, and every later run repeated it as fact.
	 */
	repairedAt?: string;
	/**
	 * The version on record before the most recent version change, kept so the
	 * first interactive launch after an upgrade can say where it came from and
	 * `doctor` can show it. Absent on a home that has never changed version.
	 */
	upgradedFrom?: string;
	/**
	 * The newer version this home was taken back from, after the operator
	 * accepted running an older PanCode on it. Cleared by the next upgrade.
	 */
	downgradedFrom?: string;
	/**
	 * The version whose upgrade notice the operator has already seen. Written
	 * by the interactive boot, once per version, so the notice never repeats.
	 */
	noticedVersion?: string;
	/** When the one-time contained-yolo notice was shown (`takeContainedYoloNotice`). */
	containedYoloNoticedAt?: string;
	platform: string;
	nodeVersion: string;
}

/**
 * Close PanCode's own private state directories found group or world readable, whoever created them. Not
 * recursive: a closed parent hides everything below it. The roots are left alone; an operator may share one with other tools.
 */
function tightenPrivateStateDirs(stateDir: string, dataDir: string): void {
	if (process.platform === "win32") return;
	const dirs = [
		...PRIVATE_STATE_SUBDIRS.map((sub) => join(stateDir, sub)),
		...DATA_SUBDIRS.map((sub) => join(dataDir, sub)),
	];
	for (const full of dirs) {
		try {
			const stat = lstatSync(full);
			if (stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) !== 0) chmodSync(full, 0o700);
		} catch {
			// Missing or unreadable: nothing to tighten.
		}
	}
}

export function initializePancodeHome(): InitReport {
	enforceHomePrefixGuard();

	// Probed from the resolved paths, before the accessors below create them:
	// pancodeStateDir() makes the directory it is being asked about, so anything
	// checked after it reports a first install on every run. A root that is
	// already there means whatever this call is about to write is a repair.
	const resolved = resolvePancodeDirs();
	// A role nested in another role turns a scoped reset into an accidental
	// cross-role wipe. Refuse before any accessor below creates a directory.
	assertPancodeDirLayout(resolved);
	const preexistingState = existsSync(resolved.state) || existsSync(resolved.data);
	const preexistingHome = preexistingState || existsSync(resolved.config);

	const configDir = pancodeConfigDir();
	const dataDir = pancodeDataDir();
	const stateDir = pancodeStateDir();
	const cacheDir = pancodeCacheDir();

	const created: string[] = [];

	for (const dir of [configDir, dataDir, stateDir, cacheDir]) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			created.push(dir);
		}
	}

	const subdirSets: ReadonlyArray<[string, ReadonlyArray<string>]> = [
		[configDir, CONFIG_SUBDIRS],
		[dataDir, DATA_SUBDIRS],
		[stateDir, STATE_SUBDIRS],
	];
	for (const [root, subs] of subdirSets) {
		for (const sub of subs) {
			const full = join(root, sub);
			if (!existsSync(full)) {
				mkdirSync(full, { recursive: true, mode: 0o700 });
				created.push(full);
			}
		}
	}
	tightenPrivateStateDirs(stateDir, dataDir);

	// Structure only: an existing settings.yaml is never read, validated, or
	// rewritten here. Content validation belongs to readSettings/doctor.
	// Both scaffolds are checked before their lock as well as inside it: the lock is
	// a file beside the target, so taking it for a file that is already there
	// rewrote the config root on every boot, a read-only one included.
	const settingsPath = join(configDir, "settings.yaml");
	let touched = false;
	if (!existsSync(settingsPath)) {
		withStateFileLockSync(settingsPath, () => {
			if (existsSync(settingsPath)) return;
			safeResourceWrite(settingsPath, SETTINGS_SCAFFOLD_YAML, { encoding: "utf8", mode: SETTINGS_FILE_MODE });
			created.push(settingsPath);
			touched = true;
		});
	}

	// installedAt is written exactly once, at first install. Any later
	// version/platform/node change preserves it and stamps upgradedAt instead.
	// Multiple PanCode processes can boot together, so the read/compare/write is one
	// locked transaction and publication is atomic. Otherwise both first boots
	// can invent different install times, or a stale writer can erase the other
	// process's noticedVersion after an upgrade.
	const installPath = join(stateDir, "home.json");
	const runningVersion = readPancodeVersion();
	let newerHome: NewerHome | undefined;
	withStateFileLockSync(installPath, () => {
		const installMetadata = readInstallMetadata(installPath);
		// A `-dev` checkout build is not a release, so it never becomes the recorded
		// version of a home it shares with an installed one. Stamping `0.6.0-dev`
		// would make the installed 0.5.9 read an upgrade from a version it never
		// shipped, and doctor, upgrade and the one-time notice all key on this field.
		// A home the dev build creates still records its own version.
		const currentVersion =
			installMetadata !== null && isDevVersion(runningVersion) ? installMetadata.version : runningVersion;
		// An older binary must not restamp a newer home as its own version.
		const newer = installMetadata ? newerHomeOf(installMetadata, runningVersion) : null;
		if (newer) {
			newerHome = newer;
			return;
		}
		if (!installMetadata) {
			const payload: InstallMetadata = {
				version: currentVersion,
				// A first install knows when it happened. A repair does not, and saying
				// `installedAt: now` there is a fact this process invented.
				...(preexistingHome ? { repairedAt: new Date().toISOString() } : { installedAt: new Date().toISOString() }),
				platform: process.platform,
				nodeVersion: process.version,
			};
			safeResourceWrite(installPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			created.push(installPath);
		} else if (
			installMetadata.version !== currentVersion ||
			installMetadata.platform !== process.platform ||
			installMetadata.nodeVersion !== process.version
		) {
			// A version change is the upgrade the record is about; a node or platform
			// change alone keeps whatever earlier transition was on record.
			const upgradedFrom =
				installMetadata.version !== currentVersion ? installMetadata.version : installMetadata.upgradedFrom;
			const payload: InstallMetadata = {
				version: currentVersion,
				...(installMetadata.installedAt !== undefined ? { installedAt: installMetadata.installedAt } : {}),
				...(installMetadata.repairedAt !== undefined ? { repairedAt: installMetadata.repairedAt } : {}),
				...(upgradedFrom !== undefined ? { upgradedFrom } : {}),
				...(installMetadata.version === currentVersion && installMetadata.downgradedFrom !== undefined
					? { downgradedFrom: installMetadata.downgradedFrom }
					: {}),
				...(installMetadata.noticedVersion !== undefined ? { noticedVersion: installMetadata.noticedVersion } : {}),
				...(installMetadata.containedYoloNoticedAt !== undefined
					? { containedYoloNoticedAt: installMetadata.containedYoloNoticedAt }
					: {}),
				upgradedAt: new Date().toISOString(),
				platform: process.platform,
				nodeVersion: process.version,
			};
			safeResourceWrite(installPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		}
	});

	return {
		configDir,
		dataDir,
		stateDir,
		cacheDir,
		createdPaths: created,
		touchedSettings: touched,
		...(newerHome ? { newerHome } : {}),
	};
}

/** The release triple of a version; a `-dev` or `-rc` suffix is ignored. */
function releaseTriple(version: string): [number, number, number] | null {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isNewerRelease(recorded: string, running: string): boolean {
	const a = releaseTriple(recorded);
	const b = releaseTriple(running);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i++) {
		if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) > (b[i] as number);
	}
	return false;
}

function newerHomeOf(metadata: InstallMetadata, runningVersion: string): NewerHome | null {
	return isNewerRelease(metadata.version, runningVersion) ? { version: metadata.version } : null;
}

/** The newer PanCode that last used this home, or null. Reads only; writes nothing. */
export function detectNewerHome(): NewerHome | null {
	const stateDir = resolvePancodeDirs().state;
	const metadata = readInstallMetadata(join(stateDir, "home.json"));
	return metadata ? newerHomeOf(metadata, readPancodeVersion()) : null;
}

/**
 * The operator accepted running an older PanCode on a newer home: record the
 * downgrade so later boots do not ask, and the home is that version's again.
 * `version` defaults to the running one; `upgrade --rollback` passes the
 * version it switched the launcher to, whose binary reads this record, with
 * `onlyFromNewer` so a rollback to a newer version records nothing. True when
 * the record was written.
 */
export function recordHomeDowngrade(
	version: string = readPancodeVersion(),
	options: { onlyFromNewer?: boolean } = {},
): boolean {
	const stateDir = pancodeStateDir();
	const installPath = join(stateDir, "home.json");
	return withStateFileLockSync(installPath, () => {
		const metadata = readInstallMetadata(installPath);
		if (!metadata) return false;
		if (options.onlyFromNewer && !isNewerRelease(metadata.version, version)) return false;
		const payload: InstallMetadata = {
			version,
			...(metadata.installedAt !== undefined ? { installedAt: metadata.installedAt } : {}),
			...(metadata.repairedAt !== undefined ? { repairedAt: metadata.repairedAt } : {}),
			downgradedFrom: metadata.version,
			...(metadata.noticedVersion !== undefined ? { noticedVersion: metadata.noticedVersion } : {}),
			...(metadata.containedYoloNoticedAt !== undefined
				? { containedYoloNoticedAt: metadata.containedYoloNoticedAt }
				: {}),
			platform: process.platform,
			nodeVersion: process.version,
		};
		safeResourceWrite(installPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		return true;
	});
}

function readInstallMetadata(path: string): InstallMetadata | null {
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<InstallMetadata>;
		// Either stamp is enough to call the record ours. Requiring installedAt
		// would make every repaired record look corrupt and get re-synthesized on
		// the next run, moving the repair time forward each time.
		if (
			typeof parsed.version === "string" &&
			(typeof parsed.installedAt === "string" || typeof parsed.repairedAt === "string") &&
			typeof parsed.platform === "string" &&
			typeof parsed.nodeVersion === "string"
		) {
			return {
				version: parsed.version,
				...(typeof parsed.installedAt === "string" ? { installedAt: parsed.installedAt } : {}),
				...(typeof parsed.upgradedAt === "string" ? { upgradedAt: parsed.upgradedAt } : {}),
				...(typeof parsed.repairedAt === "string" ? { repairedAt: parsed.repairedAt } : {}),
				...(typeof parsed.upgradedFrom === "string" ? { upgradedFrom: parsed.upgradedFrom } : {}),
				...(typeof parsed.downgradedFrom === "string" ? { downgradedFrom: parsed.downgradedFrom } : {}),
				...(typeof parsed.noticedVersion === "string" ? { noticedVersion: parsed.noticedVersion } : {}),
				...(typeof parsed.containedYoloNoticedAt === "string"
					? { containedYoloNoticedAt: parsed.containedYoloNoticedAt }
					: {}),
				platform: parsed.platform,
				nodeVersion: parsed.nodeVersion,
			};
		}
	} catch {
		// Repaired below by overwriting home.json with current metadata.
	}
	return null;
}

/**
 * Opt-in safety check that prevents tests from clobbering a parent process's
 * sandbox when the parent has PANCODE_CONFIG_DIR/PANCODE_DATA_DIR/PANCODE_STATE_DIR/
 * PANCODE_CACHE_DIR set and the test only overrides PANCODE_HOME. Individual env
 * vars take precedence over PANCODE_HOME inside resolvePancodeDirs, so a test that
 * forgets to override all five will silently inherit the parent's paths and
 * write into the wrong sandbox.
 *
 * Enable by setting PANCODE_REQUIRE_HOME_PREFIX=1 in the test env. The test
 * harness in tests/harness/tmp-root.ts opts in by default. We deliberately do
 * not enable this in production because dev installs may legitimately point
 * individual dirs outside PANCODE_HOME.
 */
function enforceHomePrefixGuard(): void {
	if (process.env.PANCODE_REQUIRE_HOME_PREFIX !== "1") return;
	const home = process.env.PANCODE_HOME?.trim();
	if (!home) return;
	const dirs = resolvePancodeDirs();
	const offenders: string[] = [];
	if (!dirs.config.startsWith(home)) offenders.push(`configDir=${dirs.config}`);
	if (!dirs.data.startsWith(home)) offenders.push(`dataDir=${dirs.data}`);
	if (!dirs.state.startsWith(home)) offenders.push(`stateDir=${dirs.state}`);
	if (!dirs.cache.startsWith(home)) offenders.push(`cacheDir=${dirs.cache}`);
	if (offenders.length === 0) return;
	throw new Error(
		`PANCODE_REQUIRE_HOME_PREFIX guardrail tripped: resolved PanCode directories escape PANCODE_HOME=${home}. ` +
			`Offending paths: ${offenders.join(", ")}. ` +
			`Individual overrides PANCODE_CONFIG_DIR, PANCODE_DATA_DIR, PANCODE_STATE_DIR, and PANCODE_CACHE_DIR take precedence ` +
			`over PANCODE_HOME, so a test that sets only PANCODE_HOME inherits whatever the parent process configured. ` +
			`Override all five env vars in lockstep to scratch subdirs (PANCODE_HOME plus PANCODE_CONFIG_DIR, ` +
			`PANCODE_DATA_DIR, PANCODE_STATE_DIR, PANCODE_CACHE_DIR pointing under it), then call resetXdgCache().`,
	);
}
