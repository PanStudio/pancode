// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { codexAccountScope } from "../../core/codex-account.js";
import { resolveAuthTarget, resolveRuntimeAuthTarget } from "../providers/auth/index.js";
import type { RuntimeDescriptor, TargetDescriptor } from "../providers/index.js";
import { createQuotaCache, DEFAULT_QUOTA_CACHE_TTL_MS, type QuotaCache } from "../quota/cache.js";
import { observedAnthropicQuota, observedCodexQuota, STREAM_QUOTA_TTL_MS } from "../quota/observed.js";
import { buildQuotaProviders, quotaProviderIdForRuntime } from "../quota/registry.js";
import { quotaSharedStatePath, readSharedQuotaState } from "../quota/shared-state.js";
import type { QuotaProvider, UsageSnapshot } from "../quota/types.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { ROUTE_QUOTA_POLL_WAIT_MS } from "./bundle-support.js";
import type { BudgetPoolView } from "./contract.js";
import { budgetPoolView } from "./economics-view.js";

export function createQuotaPolling(rt: DispatchRuntime) {
	const { options } = rt;
	const { getEffectiveSettings, now, providers } = rt.core;

	/** The quota adapter that reads the credential a route spends now, or why none does. */
	function routeQuotaProvider(target: TargetDescriptor, runtime: RuntimeDescriptor): QuotaProvider | string {
		const providerId = quotaProviderIdForRuntime(runtime.id);
		if (providerId === null) return `runtime ${runtime.id} reports no quota`;
		if (resolveAuthTarget(target, runtime).providerId !== resolveRuntimeAuthTarget(runtime).providerId)
			return "the route spends a credential the quota reader does not read";
		return (
			(options?.quotaProviders ?? buildQuotaProviders)().find((candidate) => candidate.id === providerId) ??
			`no quota reader for ${providerId} here`
		);
	}

	/** The credential a quota adapter reads now: undefined when it names none, null when it cannot be read. */
	async function quotaCredentialScope(provider: QuotaProvider): Promise<string | null | undefined> {
		return provider.credentialScope === undefined ? undefined : await provider.credentialScope().catch(() => null);
	}

	/**
	 * The shared poll reading of a route's pool, made with the credential that route spends now. The quota adapter reads
	 * the runtime's own login, so a target naming another credential has no reading, and an unknown identity on either
	 * side matches nothing. Reads the shared cache file only, never the network.
	 */
	function sharedRouteQuota(
		provider: QuotaProvider,
		scope: string | null | undefined,
		nowMs: number,
	): BudgetPoolView | string {
		const shared = readSharedQuotaState(quotaSharedStatePath(), nowMs);
		const entry = shared.entries.get(provider.id);
		if (entry === undefined || entry.storedAtMs <= (shared.cleared.get(provider.id) ?? Number.NEGATIVE_INFINITY))
			return "no cached quota reading";
		if (scope === null || scope === undefined || entry.scope !== scope)
			return "no quota reading for the route's current credential";
		const view = budgetPoolView(entry.snapshot, nowMs, DEFAULT_QUOTA_CACHE_TTL_MS, "poll");
		return view.status === "reading" ? view : view.reason;
	}

	/**
	 * The newest quota this process's own requests on the route reported in band, under the credential the route spends
	 * now: a Codex stream event for the request's ChatGPT account, Anthropic headers for the OAuth profile (#423).
	 */
	function streamedRouteQuota(
		target: TargetDescriptor,
		runtime: RuntimeDescriptor,
		nowMs: number,
	): { snapshot: UsageSnapshot; source: BudgetPoolView["source"] } | null {
		if (runtime.id !== "openai-codex" && runtime.id !== "anthropic-max") return null;
		const status = providers.auth.statusForTarget(target, runtime);
		if (runtime.id === "anthropic-max") {
			const profile = status.source === "stored-oauth" ? status.providerId : null;
			const snapshot = observedAnthropicQuota(target.id, nowMs, profile)?.snapshot;
			return snapshot ? { snapshot, source: "response-headers" } : null;
		}
		const stored = status.source === "stored-oauth" ? providers.auth.getStored(status.providerId) : null;
		const scope = stored?.type === "oauth" ? codexAccountScope(stored.access) : null;
		const snapshot = observedCodexQuota(target.id, scope, nowMs)?.snapshot;
		return snapshot ? { snapshot, source: "stream-event" } : null;
	}

	/** The running usage poll per quota adapter and credential, and when it began: its wait bound runs from there. */
	const routeQuotaPolls = new Map<string, { startedAtMs: number; answer: Promise<UsageSnapshot | null> }>();
	let routeQuotaCache: QuotaCache | null = null;
	const routeQuotaPollKey = (provider: QuotaProvider, scope: string | null | undefined): string =>
		JSON.stringify([provider.id, scope ?? null]);

	/**
	 * The usage poll for the credential a route spends now: the one already running for that credential, else one new
	 * read through the shared quota cache, which honours its holds and publishes the reading to every process. Keyed by
	 * credential, so a caller after a login change never joins the previous account's poll.
	 */
	function routeQuotaPoll(
		provider: QuotaProvider,
		scope: string | null | undefined,
	): { startedAtMs: number; answer: Promise<UsageSnapshot | null> } {
		const key = routeQuotaPollKey(provider, scope);
		const running = routeQuotaPolls.get(key);
		if (running !== undefined) return running;
		routeQuotaCache ??= createQuotaCache({
			ttlMs: DEFAULT_QUOTA_CACHE_TTL_MS,
			now,
			sharedStatePath: quotaSharedStatePath(),
		});
		const poll = { startedAtMs: now(), answer: routeQuotaCache.resolve(provider).catch(() => null) };
		routeQuotaPolls.set(key, poll);
		void poll.answer.then(() => {
			if (routeQuotaPolls.get(key) === poll) routeQuotaPolls.delete(key);
		});
		return poll;
	}

	/**
	 * The route's poll answer, waiting only out the rest of its ROUTE_QUOTA_POLL_WAIT_MS bound counted from the poll's
	 * own start, so a poll primed at run start costs a later read nothing and no read waits a second full bound. The
	 * answer counts only while the route still spends the credential the poll read for; the poll runs on past the bound.
	 */
	async function awaitRouteQuotaPoll(
		provider: QuotaProvider,
		scope: string | null | undefined,
	): Promise<UsageSnapshot | string> {
		const poll = routeQuotaPoll(provider, scope);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<"late">((resolve) => {
			timer = setTimeout(() => resolve("late"), Math.max(0, poll.startedAtMs + ROUTE_QUOTA_POLL_WAIT_MS - now()));
			timer.unref?.();
		});
		let answer: UsageSnapshot | null | "late";
		try {
			answer = await Promise.race([poll.answer, late]);
		} finally {
			clearTimeout(timer);
		}
		if (answer === "late") return `the quota poll did not answer within ${ROUTE_QUOTA_POLL_WAIT_MS / 1000}s`;
		if (answer === null) return "the quota poll failed";
		if ((await quotaCredentialScope(provider)) !== scope) return "the route's credential changed during the quota poll";
		return answer;
	}

	/** The chat route by the effective settings, or null when there is none. */
	function chatQuotaRoute(): { target: TargetDescriptor; runtime: RuntimeDescriptor } | null {
		const target = providers.getTarget(getEffectiveSettings()?.chat?.target ?? "");
		const runtime = target === null ? null : providers.getRuntime(target.runtime);
		return target === null || runtime === null ? null : { target, runtime };
	}

	/**
	 * S16: start the chat route's one bounded usage poll off the turn path when its shared reading is not fresh, so a
	 * headless run's first budget read finds the answer held or waits only out the rest of the bound. Never a model call.
	 */
	function primeRouteQuota(): void {
		const route = chatQuotaRoute();
		const provider = route === null ? "no chat route" : routeQuotaProvider(route.target, route.runtime);
		if (typeof provider === "string") return;
		void quotaCredentialScope(provider).then((scope) => {
			const shared = sharedRouteQuota(provider, scope, now());
			if (typeof shared === "string" || !shared.fresh) routeQuotaPoll(provider, scope);
		});
	}

	/**
	 * The chat route's pool as `context(scope="budget")` shows it: a fresh shared poll reading first, else this
	 * process's own fresh in-band reading (a headless run that just heard from the provider, a denial included), and
	 * only with neither the route's usage poll (the one primed at run start, else one started here) within the rest of
	 * its bound. With none fresh, the newest held reading marked not fresh. Age and freshness come from each reading's
	 * own as-of time, never from this read.
	 */
	async function routeQuotaPool(
		target: TargetDescriptor,
		runtime: RuntimeDescriptor,
	): Promise<BudgetPoolView | { status: "none"; reason: string }> {
		const provider = routeQuotaProvider(target, runtime);
		const held: BudgetPoolView[] = [];
		let reason = typeof provider === "string" ? provider : "no quota reading";
		const hold = (view: BudgetPoolView | string): BudgetPoolView | null => {
			if (typeof view === "string") reason = view;
			else if (view.fresh) return view;
			else held.push(view);
			return null;
		};
		const scope = typeof provider === "string" ? undefined : await quotaCredentialScope(provider);
		if (typeof provider !== "string") {
			const shared = hold(sharedRouteQuota(provider, scope, now()));
			if (shared !== null) return shared;
		}
		const streamed = streamedRouteQuota(target, runtime, now());
		if (streamed !== null) {
			const view = budgetPoolView(streamed.snapshot, now(), STREAM_QUOTA_TTL_MS, streamed.source);
			const fresh = hold(view.status === "reading" ? view : view.reason);
			if (fresh !== null) return fresh;
		}
		if (typeof provider !== "string") {
			const answer = await awaitRouteQuotaPoll(provider, scope);
			const view = typeof answer === "string" ? answer : budgetPoolView(answer, now(), DEFAULT_QUOTA_CACHE_TTL_MS, "poll");
			const polled = hold(typeof view === "string" || view.status === "reading" ? view : view.reason);
			if (polled !== null) return polled;
		}
		held.sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));
		return held[0] ?? { status: "none", reason };
	}

	return {
		chatQuotaRoute,
		primeRouteQuota,
		routeQuotaPool,
	};
}
