// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * What the operator has learned about PanCode itself, across every project.
 *
 * Guidance tips read it to stay relevant: a feature the operator already uses
 * needs no tip, a tip already shown twice is retired, and the topics the
 * operator asks PanCode about show where the harness confused them. It is runtime
 * state kept in the state dir (harness-profile.json), never configuration and
 * never model context. Writes are best-effort and merge with what other
 * sessions wrote since the last read, like recent-models.json.
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { safeResourceWrite } from "./safe-resource-write.js";
import { pancodeStateDir, stateRootRemoved } from "./xdg.js";

export interface HarnessProfileLesson {
	shown: number;
	lastShownAt: string;
}

export interface HarnessFeatureTiming {
	firstUsedAt: string;
	lastUsedAt: string;
}

export interface HarnessProfile {
	version: 1;
	/** Guidance lessons by id: how often each was shown and when last. */
	lessons: Record<string, HarnessProfileLesson>;
	/** Features the operator used themselves, such as "/view", "!" or "@". */
	features: Record<string, number>;
	/** First and last ISO timestamps per recorded feature; absent in older files until next use. */
	featureTimes?: Record<string, HarnessFeatureTiming>;
	/** Harness topics the operator asked PanCode about, such as "settings" or "keys". */
	topics: Record<string, number>;
}

/** Bounds keep a long-lived profile small whatever feeds it. */
const MAX_KEYS = 200;
const MAX_KEY_LENGTH = 64;
/** Coalesce bursty feature writes off the keystroke and token-delta paths. */
const WRITE_DEBOUNCE_MS = 500;

export function emptyHarnessProfile(): HarnessProfile {
	return { version: 1, lessons: {}, features: {}, topics: {} };
}

export function harnessProfilePath(): string {
	return join(pancodeStateDir(), "harness-profile.json");
}

function counts(value: unknown): Record<string, number> {
	const out: Record<string, number> = {};
	if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
	for (const [key, count] of Object.entries(value).slice(0, MAX_KEYS)) {
		if (key.length > 0 && key.length <= MAX_KEY_LENGTH && Number.isSafeInteger(count) && (count as number) > 0)
			out[key] = count as number;
	}
	return out;
}

function featureTimings(value: unknown): Record<string, HarnessFeatureTiming> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, HarnessFeatureTiming> = {};
	let count = 0;
	for (const [key, entry] of Object.entries(value).slice(0, MAX_KEYS)) {
		if (key.length === 0 || key.length > MAX_KEY_LENGTH || entry === null || typeof entry !== "object") continue;
		const { firstUsedAt, lastUsedAt } = entry as Record<string, unknown>;
		if (typeof firstUsedAt !== "string" || typeof lastUsedAt !== "string") continue;
		if (firstUsedAt.length === 0 || lastUsedAt.length === 0) continue;
		out[key] = { firstUsedAt, lastUsedAt };
		count += 1;
	}
	return count > 0 ? out : undefined;
}

function parseProfile(raw: string): HarnessProfile {
	const parsed: unknown = JSON.parse(raw);
	const profile = emptyHarnessProfile();
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return profile;
	const record = parsed as Record<string, unknown>;
	const lessons = record.lessons;
	if (lessons !== null && typeof lessons === "object" && !Array.isArray(lessons)) {
		for (const [id, entry] of Object.entries(lessons).slice(0, MAX_KEYS)) {
			if (entry === null || typeof entry !== "object") continue;
			const { shown, lastShownAt } = entry as Record<string, unknown>;
			if (id.length > MAX_KEY_LENGTH || !Number.isSafeInteger(shown) || typeof lastShownAt !== "string") continue;
			profile.lessons[id] = { shown: shown as number, lastShownAt };
		}
	}
	profile.features = counts(record.features);
	const times = featureTimings(record.featureTimes);
	if (times !== undefined) profile.featureTimes = times;
	profile.topics = counts(record.topics);
	return profile;
}

interface PendingFeatureDelta {
	delta: number;
	firstUsedAt: string;
	lastUsedAt: string;
}

const EMPTY_PROFILE: HarnessProfile = Object.freeze({ version: 1, lessons: {}, features: {}, topics: {} });

let cache: HarnessProfile | null = null;
let cachePath: string | null = null;
let hydratedPath: string | null = null;
let hydrateInFlight: { path: string; promise: Promise<HarnessProfile> } | null = null;
let profileRevision = 0;
let pendingPath: string | null = null;
const pendingFeatures = new Map<string, PendingFeatureDelta>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function notifyListeners(): void {
	for (const listener of [...listeners]) listener();
}

function minIso(a: string, b: string): string {
	return a <= b ? a : b;
}

function maxIso(a: string, b: string): string {
	return a >= b ? a : b;
}

function recordTiming(profile: HarnessProfile, key: string, firstUsedAt: string, lastUsedAt: string): void {
	if (profile.featureTimes === undefined) profile.featureTimes = {};
	const times = profile.featureTimes;
	const existing = times[key];
	times[key] =
		existing === undefined
			? { firstUsedAt, lastUsedAt }
			: {
					firstUsedAt: minIso(existing.firstUsedAt, firstUsedAt),
					lastUsedAt: maxIso(existing.lastUsedAt, lastUsedAt),
				};
}

function applyPending(profile: HarnessProfile, path: string): void {
	if (pendingPath !== path || pendingFeatures.size === 0) return;
	for (const [key, entry] of pendingFeatures) {
		if (profile.features[key] === undefined && Object.keys(profile.features).length >= MAX_KEYS) continue;
		profile.features[key] = (profile.features[key] ?? 0) + entry.delta;
		recordTiming(profile, key, entry.firstUsedAt, entry.lastUsedAt);
	}
}

function clearPending(): void {
	pendingFeatures.clear();
	pendingPath = null;
	if (flushTimer !== null) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
}

function readFromDisk(path: string): HarnessProfile {
	if (!existsSync(path)) return emptyHarnessProfile();
	try {
		return parseProfile(readFileSync(path, "utf8"));
	} catch {
		// An unreadable profile starts over; it only tunes which tips appear.
		return emptyHarnessProfile();
	}
}

/**
 * Current profile without touching the filesystem. Returns the cached profile once
 * hydrated or written, or an empty profile with `hydrated: false` before first paint.
 */
export function peekHarnessProfile(): {
	readonly profile: HarnessProfile;
	readonly revision: number;
	readonly hydrated: boolean;
} {
	const path = harnessProfilePath();
	if (cache !== null && cachePath === path) {
		return { profile: cache, revision: profileRevision, hydrated: hydratedPath === path };
	}
	return { profile: EMPTY_PROFILE, revision: profileRevision, hydrated: false };
}

/** Subscribe to profile hydration and feature/lesson updates. */
export function subscribeHarnessProfile(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Lazily load `harness-profile.json` off the first-paint path and merge any
 * features recorded in memory before hydration landed.
 */
export function hydrateHarnessProfile(): Promise<HarnessProfile> {
	const path = harnessProfilePath();
	if (hydratedPath === path && cache !== null && cachePath === path) return Promise.resolve(cache);
	if (hydrateInFlight !== null && hydrateInFlight.path === path) return hydrateInFlight.promise;
	const promise = readFile(path, "utf8")
		.then((raw) => {
			try {
				return parseProfile(raw);
			} catch {
				// An unreadable profile starts over; it only tunes which tips appear.
				return emptyHarnessProfile();
			}
		})
		.catch(() => emptyHarnessProfile())
		.then((disk) => {
			if (harnessProfilePath() !== path) return disk;
			applyPending(disk, path);
			cache = disk;
			cachePath = path;
			hydratedPath = path;
			profileRevision += 1;
			notifyListeners();
			return disk;
		})
		.finally(() => {
			if (hydrateInFlight?.promise === promise) hydrateInFlight = null;
		});
	hydrateInFlight = { path, promise };
	return promise;
}

/** The current profile. Reads the file once per path and serves the cache after. */
export function readHarnessProfile(): HarnessProfile {
	const path = harnessProfilePath();
	if (cache === null || cachePath !== path) {
		const loaded = readFromDisk(path);
		applyPending(loaded, path);
		cache = loaded;
		cachePath = path;
		hydratedPath = path;
	}
	return cache;
}

function update(mutate: (profile: HarnessProfile) => void): HarnessProfile {
	const path = harnessProfilePath();
	// Re-read so what other sessions recorded since the last load merges in.
	const next = readFromDisk(path);
	applyPending(next, path);
	clearPending();
	mutate(next);
	cache = next;
	cachePath = path;
	hydratedPath = path;
	profileRevision += 1;
	notifyListeners();
	if (stateRootRemoved()) return next;
	try {
		safeResourceWrite(path, `${JSON.stringify(next, null, "\t")}\n`, { encoding: "utf8" });
	} catch {
		// Best-effort: the in-memory profile still steers this session.
	}
	return next;
}

function bump(record: Record<string, number>, key: string): string | null {
	const trimmed = key.trim().slice(0, MAX_KEY_LENGTH);
	if (trimmed.length === 0) return null;
	if (record[trimmed] === undefined && Object.keys(record).length >= MAX_KEYS) return null;
	record[trimmed] = (record[trimmed] ?? 0) + 1;
	return trimmed;
}

/** The operator used `feature` themselves, so tips about it are no longer needed. */
export function recordHarnessFeature(feature: string, now = new Date()): void {
	const iso = now.toISOString();
	update((profile) => {
		const key = bump(profile.features, feature);
		if (key !== null) recordTiming(profile, key, iso, iso);
	});
}

/**
 * Record one feature use in memory immediately and debounce the disk write off
 * keystroke and delta paths. Call `flushHarnessProfile()` on teardown.
 */
export function scheduleHarnessFeature(feature: string, now = new Date()): void {
	const trimmed = feature.trim().slice(0, MAX_KEY_LENGTH);
	if (trimmed.length === 0) return;
	const iso = now.toISOString();
	const path = harnessProfilePath();
	if (pendingPath !== null && pendingPath !== path) clearPending();
	const base = cache !== null && cachePath === path ? cache : emptyHarnessProfile();
	if (base.features[trimmed] === undefined && Object.keys(base.features).length >= MAX_KEYS) return;
	const nextFeatures = { ...base.features, [trimmed]: (base.features[trimmed] ?? 0) + 1 };
	const existingTime = base.featureTimes?.[trimmed];
	const nextTimes: Record<string, HarnessFeatureTiming> = {
		...base.featureTimes,
		[trimmed]:
			existingTime === undefined
				? { firstUsedAt: iso, lastUsedAt: iso }
				: { firstUsedAt: minIso(existingTime.firstUsedAt, iso), lastUsedAt: maxIso(existingTime.lastUsedAt, iso) },
	};
	cache = { ...base, features: nextFeatures, featureTimes: nextTimes };
	cachePath = path;
	const pending = pendingFeatures.get(trimmed);
	pendingPath = path;
	pendingFeatures.set(
		trimmed,
		pending === undefined
			? { delta: 1, firstUsedAt: iso, lastUsedAt: iso }
			: {
					delta: pending.delta + 1,
					firstUsedAt: minIso(pending.firstUsedAt, iso),
					lastUsedAt: maxIso(pending.lastUsedAt, iso),
				},
	);
	profileRevision += 1;
	notifyListeners();
	if (flushTimer !== null) clearTimeout(flushTimer);
	flushTimer = setTimeout(() => {
		flushTimer = null;
		flushHarnessProfile();
	}, WRITE_DEBOUNCE_MS);
	flushTimer.unref?.();
}

/** Flush any debounced feature uses to disk via `safeResourceWrite`. */
export function flushHarnessProfile(): void {
	if (flushTimer !== null) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	if (pendingFeatures.size === 0 || pendingPath === null) return;
	const path = pendingPath;
	if (stateRootRemoved()) {
		clearPending();
		return;
	}
	const merged = readFromDisk(path);
	applyPending(merged, path);
	clearPending();
	if (harnessProfilePath() === path) {
		cache = merged;
		cachePath = path;
		hydratedPath = path;
	}
	try {
		safeResourceWrite(path, `${JSON.stringify(merged, null, "\t")}\n`, { encoding: "utf8" });
	} catch {
		// Best-effort: the in-memory profile still steers this session.
	}
}

/** The operator asked PanCode about `topic`. */
export function recordHarnessTopic(topic: string): void {
	update((profile) => {
		bump(profile.topics, topic);
	});
}

/** A guidance lesson reached the operator. */
export function recordLessonShown(id: string, now = new Date()): void {
	update((profile) => {
		const key = id.slice(0, MAX_KEY_LENGTH);
		if (profile.lessons[key] === undefined && Object.keys(profile.lessons).length >= MAX_KEYS) return;
		profile.lessons[key] = { shown: (profile.lessons[key]?.shown ?? 0) + 1, lastShownAt: now.toISOString() };
	});
}
