// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ExtensionApiV2, ExtensionContextV2, ExtensionOutputV2 } from "pancode/sdk/extension";
import { runResearchCli } from "./cli.ts";
import { researchHost, researchRoot } from "./runner.ts";
import { detailPanel, LIST_ACTION, listPanel, OPEN_ACTION, REFRESH_ACTION } from "./view.ts";

/** The session state key naming the campaign the panel shows, absent on the list. */
const OPEN_KEY = "panel.open";

function failure(error: unknown): ExtensionOutputV2 {
	return { text: `research: ${error instanceof Error ? error.message : String(error)}`, exitCode: 1 };
}

async function panelFor(ctx: ExtensionContextV2, id: string | undefined): Promise<ExtensionOutputV2> {
	try {
		const root = researchRoot(ctx);
		if (id === undefined) {
			await ctx.state.delete(OPEN_KEY);
			return listPanel(root);
		}
		await ctx.state.set(OPEN_KEY, id);
		return detailPanel(root, id);
	} catch (error) {
		return failure(error);
	}
}

export default function extension(api: ExtensionApiV2): void {
	api.handle("research", async (args, ctx) => {
		const argv = ctx.argv !== undefined ? [...ctx.argv] : args.split(/\s+/u).filter(Boolean);
		// `/research` alone opens the panel; with arguments a session runs the verb like the shell does.
		if (ctx.argv === undefined && argv.length === 0) return panelFor(ctx, undefined);
		const result = await runResearchCli(argv, () => researchHost(ctx));
		// A session shows no stderr, so `/research <verb>` reads the diagnostics with the answer.
		if (ctx.argv === undefined) return { text: `${result.stdout}${result.stderr}`, exitCode: result.exitCode };
		return {
			text: result.stdout,
			...(result.stderr.length > 0 ? { stderr: result.stderr } : {}),
			exitCode: result.exitCode,
		};
	});
	api.action(OPEN_ACTION, (event, ctx) => panelFor(ctx, event.key));
	api.action(LIST_ACTION, (_event, ctx) => panelFor(ctx, undefined));
	api.action(REFRESH_ACTION, async (_event, ctx) => {
		const open = (await ctx.state.get<string>(OPEN_KEY)).value;
		return panelFor(ctx, typeof open === "string" ? open : undefined);
	});
}
