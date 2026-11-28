import type { ExtensionApiV2 } from "pancode/sdk/extension";
import { runArenaCli } from "./cli.ts";
import { arenaHost } from "./runner.ts";

export default function extension(api: ExtensionApiV2): void {
	api.handle("arena", async (args, ctx) => {
		const result = await runArenaCli(ctx.argv !== undefined ? [...ctx.argv] : args.split(/\s+/u).filter(Boolean), () =>
			arenaHost(ctx),
		);
		// A session shows no stderr, so `/ext:arena:arena` reads the diagnostics with the answer.
		if (ctx.argv === undefined) return { text: `${result.stdout}${result.stderr}`, exitCode: result.exitCode };
		return {
			text: result.stdout,
			...(result.stderr.length > 0 ? { stderr: result.stderr } : {}),
			exitCode: result.exitCode,
		};
	});
}
