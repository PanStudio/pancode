import type { ExtensionApiV2 } from "pancode/sdk/extension";
import { runCampaignCli } from "./cli.ts";
import { campaignHost } from "./runner.ts";

export default function extension(api: ExtensionApiV2): void {
	api.handle("campaign", async (args, ctx) => {
		const result = await runCampaignCli(ctx.argv !== undefined ? [...ctx.argv] : args.split(/\s+/u).filter(Boolean), () =>
			campaignHost(ctx),
		);
		// A session shows no stderr, so `/ext:campaign:campaign` reads the diagnostics with the answer.
		if (ctx.argv === undefined) return { text: `${result.stdout}${result.stderr}`, exitCode: result.exitCode };
		return {
			text: result.stdout,
			...(result.stderr.length > 0 ? { stderr: result.stderr } : {}),
			exitCode: result.exitCode,
		};
	});
}
