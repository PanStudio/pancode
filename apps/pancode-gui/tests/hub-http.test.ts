// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { TSchema } from "typebox";
import {
	HubAgents,
	HubApplyResult,
	HubExtensions,
	HubInventory,
	HubPlan,
	HubPlanReleased,
	HubVerifiers,
} from "../contracts/hub.js";
import { harness, json } from "./harness/app.js";
import { hubOracle, seedHub, sourceCliEnv } from "./harness/hub-fixture.js";

test("all PanHub collections agree with the canonical CLI in the same scratch home and never run a verifier", async () => {
	const h = await harness({}, { env: sourceCliEnv });
	try {
		await seedHub(h.home.path, h.home.env);
		const workspace = await h.workspaces.open(h.home.path),
			base = `/api/workspaces/${workspace.id}/hub`;
		// A problem body would otherwise surface as a schema mismatch that hides the server's own reason.
		const read = async <S extends TSchema>(path: string, schema: S) => {
			const response = await h.request(path);
			assert.equal(response.status, 200, await response.clone().text());
			return json(response, schema);
		};
		const inventory = await read(base, HubInventory);
		const agents = await read(`${base}/agents`, HubAgents);
		const extensions = await read(`${base}/extensions`, HubExtensions);
		const verifiers = await read(`${base}/verifiers`, HubVerifiers);
		const oracle = await hubOracle(h.home.path, h.home.env);
		for (const kind of ["skill", "prompt", "playbook", "agent"]) {
			const actual = inventory.resources.filter((row) => row.kind === kind);
			assert.ok(actual.length > 0, `${kind} collection is seeded`);
			assert.deepEqual(
				actual.map((row) => row.key),
				oracle.recipes.resources
					.filter((row: { kind: string }) => row.kind === kind)
					.map((row: { key: string }) => row.key),
			);
		}
		assert.equal(inventory.packages.length, oracle.packages.entries.length);
		assert.ok(inventory.packages.some((row) => row.kind === "plugin"));
		assert.deepEqual(
			agents.agents.map((row) => row.id),
			oracle.agents.map((row: { id: string }) => row.id),
		);
		assert.equal(extensions.extensions.length, oracle.extensions.extensions.length);
		assert.equal(extensions.extensions[0]?.id, "fixture-extension");
		assert.equal(extensions.extensions[0]?.loadable, true);
		assert.deepEqual(verifiers.checks, oracle.verifiers.checks);
		assert.ok(verifiers.checks.length > 0);
		assert.equal(existsSync(join(h.home.path, "check-ran")), false);
		for (const path of [base, `${base}/agents`, `${base}/extensions`, `${base}/verifiers`])
			assert.equal((await h.post(path)).status, 405);
		assert.equal((await h.request(`${base}?install=yes`)).status, 422);
		await writeFile(join(h.home.path, ".pancode/verifiers.yaml"), "version: invalid\nchecks: nope\n");
		const rejected = await json(await h.request(`${base}/verifiers`), HubVerifiers);
		assert.equal(rejected.catalogValid, false);
		assert.equal(rejected.discovery, "blocked");
		assert.ok(rejected.rejection);
		await writeFile(join(oracle.extensions.extensions[0].rootPath, "pancode-extension.yaml"), "broken");
		const damaged = await json(await h.request(`${base}/extensions`), HubExtensions);
		assert.equal(damaged.extensions[0]?.valid, false);
		assert.equal(damaged.extensions[0]?.loadable, false);
		assert.equal(existsSync(join(h.home.path, "check-ran")), false);
		assert.equal(h.cli.activeCount, 0);
	} finally {
		await h.close();
	}
});

test("a catalog package installs and removes through one reviewed plan, and a plan applies exactly once", async () => {
	const h = await harness();
	try {
		await seedHub(h.home.path, h.home.env);
		const workspace = await h.workspaces.open(h.home.path),
			base = `/api/workspaces/${workspace.id}/hub`;
		const before = await json(await h.request(base), HubInventory);
		const offer = before.packages.find((row) => row.kind === "skill" && row.catalogOrigin === "catalog");
		assert.ok(offer, "the bundled catalog offers a skill");
		assert.ok(offer.version, "the offered skill names its catalog version");
		assert.deepEqual(offer.copies, []);

		const plan = await json(await h.post(`${base}/plans`, { operation: "install", ref: offer.ref }), HubPlan);
		assert.equal(plan.applicable, true);
		assert.equal(plan.steps.at(-1)?.identity.ref, offer.ref);
		assert.equal(plan.steps.at(-1)?.identity.scope, "user");
		assert.equal(plan.steps.at(-1)?.source?.sha256, offer.sha256);
		assert.equal(plan.steps.at(-1)?.content?.valid, true);
		// Planning writes nothing.
		assert.deepEqual(
			(await json(await h.request(base), HubInventory)).packages.find((row) => row.ref === offer.ref)?.copies,
			[],
		);

		const applied = await json(await h.post(`${base}/plans/${plan.id}/apply`), HubApplyResult);
		assert.equal(applied.failed, 0);
		assert.equal(applied.committed, plan.steps.length);
		const outcome = applied.outcomes.at(-1);
		assert.equal(outcome?.verification?.tree, "present");
		assert.equal(outcome?.verification?.record, "recorded");
		assert.equal(applied.refresh.status, "not-applicable");
		assert.deepEqual(
			(await json(await h.request(base), HubInventory)).packages
				.find((row) => row.ref === offer.ref)
				?.copies.map(({ scope, state, version }) => ({ scope, state, version })),
			[{ scope: "user", state: "loadable", version: offer.version }],
		);
		assert.equal((await h.post(`${base}/plans/${plan.id}/apply`)).status, 404);

		// A second install is refused in the plan, before anything is staged.
		const again = await json(await h.post(`${base}/plans`, { operation: "install", ref: offer.ref }), HubPlan);
		assert.equal(again.applicable, false);
		assert.match(again.steps.at(-1)?.refusal ?? "", /already installed/);
		const released = await h.request(`${base}/plans/${again.id}`, {
			method: "DELETE",
			headers: { "Content-Type": "application/json", "Idempotency-Key": "release-1" },
			body: "{}",
		});
		assert.deepEqual(await json(released, HubPlanReleased), { released: true });
		assert.equal((await h.post(`${base}/plans/${again.id}/apply`)).status, 404);

		const removal = await json(
			await h.post(`${base}/plans`, { operation: "remove", ref: offer.ref, scope: "user" }),
			HubPlan,
		);
		assert.equal(removal.applicable, true);
		const removed = await json(await h.post(`${base}/plans/${removal.id}/apply`), HubApplyResult);
		assert.equal(removed.committed, 1);
		assert.equal(removed.outcomes[0]?.verification?.tree, "absent");
		assert.deepEqual(
			(await json(await h.request(base), HubInventory)).packages.find((row) => row.ref === offer.ref)?.copies,
			[],
		);

		assert.equal((await h.post(`${base}/plans`, { operation: "remove", ref: offer.ref })).status, 404);
		assert.equal((await h.post(`${base}/plans`, { operation: "install", ref: "skill:no-such-package" })).status, 404);
		for (const ref of ["../extension-source", "https://github.com/a/b/tree/main/x", "map-codebase"])
			assert.equal((await h.post(`${base}/plans`, { operation: "install", ref })).status, 422);
		assert.equal((await h.post(`${base}/plans`, { operation: "import", ref: offer.ref })).status, 422);
	} finally {
		await h.close();
	}
});

test("an applied change reaches the project's open conversations, and a reload that fails is reported as failed", async () => {
	for (const [env, expected] of [
		[{}, "refreshed"],
		[{ PANCODE_WEB_FIXTURE_HUB_RELOAD: "fail" }, "failed"],
	] as const) {
		const h = await harness({}, { scenario: "markdown", env });
		try {
			await seedHub(h.home.path, h.home.env);
			const workspace = await h.workspaces.open(h.home.path),
				base = `/api/workspaces/${workspace.id}/hub`;
			const session = await h.supervisor.open(workspace.id);
			const offer = (await json(await h.request(base), HubInventory)).packages.find(
				(row) => row.kind === "skill" && row.catalogOrigin === "catalog",
			);
			assert.ok(offer);
			const plan = await json(await h.post(`${base}/plans`, { operation: "install", ref: offer.ref }), HubPlan);
			const applied = await json(await h.post(`${base}/plans/${plan.id}/apply`), HubApplyResult);
			assert.ok(applied.committed > 0);
			assert.equal(applied.refresh.status, expected);
			const log = await readFile(join(h.home.path, "acp.jsonl"), "utf8");
			if (expected === "refreshed") {
				assert.deepEqual(applied.refresh, { status: "refreshed", sessions: 1, generation: 2, changed: true });
				assert.match(log, /"hubReloaded":2/, "the open conversation reloaded");
			} else {
				assert.deepEqual(applied.refresh, {
					status: "failed",
					sessions: 1,
					failedSessions: 1,
					error: "plugin tree digest mismatch",
				});
				assert.doesNotMatch(log, /"hubReloaded"/);
			}
			await h.supervisor.close(session.id);
		} finally {
			await h.close();
		}
	}
});

test("an open conversation from a build that cannot reload makes the refresh failed, not refreshed", async () => {
	const h = await harness();
	try {
		await seedHub(h.home.path, h.home.env);
		const workspace = await h.workspaces.open(h.home.path),
			base = `/api/workspaces/${workspace.id}/hub`;
		await h.supervisor.open(workspace.id);
		const offer = (await json(await h.request(base), HubInventory)).packages.find(
			(row) => row.kind === "skill" && row.catalogOrigin === "catalog",
		);
		assert.ok(offer);
		const plan = await json(await h.post(`${base}/plans`, { operation: "install", ref: offer.ref }), HubPlan);
		const applied = await json(await h.post(`${base}/plans/${plan.id}/apply`), HubApplyResult);
		assert.equal(applied.refresh.status, "failed");
		assert.match(applied.refresh.status === "failed" ? applied.refresh.error : "", /cannot reload its packs/);
	} finally {
		await h.close();
	}
});
