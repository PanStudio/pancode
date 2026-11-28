// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { resolve } from "node:path";
import type { ExtensionContextV2 } from "pancode/sdk/extension";
import { createServiceAgentRunner } from "./agent.ts";
import type { ResearchHost } from "./cli.ts";
import { openResearchCampaign, type ResearchServices, resumeResearchCampaign, runResearchCampaign } from "./loop.ts";

type Services = ResearchServices & { runs: NonNullable<ExtensionContextV2["runs"]> };

function services(ctx: ExtensionContextV2): Services {
	const { runs, worktrees, verify, claims } = ctx;
	if (runs === undefined || worktrees === undefined || verify === undefined || claims === undefined)
		throw new Error(
			"research needs the runs, worktrees, verify and claims services; pancode extensions services research approves them",
		);
	return { runs, worktrees, verify, claims };
}

/** The extension's project directory, `<repository>/.pancode/data/research/`. */
export function researchRoot(ctx: ExtensionContextV2): string {
	if (ctx.projectDir === undefined)
		throw new Error("research keeps its campaigns in the project and has no project directory here");
	return ctx.projectDir;
}

/**
 * The host side of `pancode research`: campaigns live in the extension's project directory, and each runs its agent,
 * worktrees, checks and claims through the host's services.
 */
export function researchHost(ctx: ExtensionContextV2): ResearchHost {
	const root = researchRoot(ctx);
	const deps = (log: (line: string) => void) => {
		const resolved = services(ctx);
		return { root, services: resolved, agent: createServiceAgentRunner(resolved.runs), log, signal: ctx.signal };
	};
	return {
		root,
		project: resolve(root, "..", "..", ".."),
		yoloRefusal: async () => services(ctx).runs.refusal({ autonomy: "yolo" }),
		open: (request) =>
			openResearchCampaign(services(ctx), { root, ...request, pancodeVersion: ctx.snapshot.pancodeVersion }),
		run: (campaign, log) => runResearchCampaign(campaign, deps(log)),
		resume: (campaign, log) => resumeResearchCampaign(campaign, deps(log)),
		progress: (line) => ctx.progress?.(line),
	};
}
