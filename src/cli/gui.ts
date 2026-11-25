// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePackageRoot } from "../core/package-root.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import { printError } from "./argv.js";

export async function inspectGuiBackground(fix: boolean): Promise<DoctorFinding[]> {
	const root = resolvePackageRoot();
	const entry = join(root, "dist/gui/server.js");
	const server = await import(pathToFileURL(entry).href);
	return server.inspectGuiBackground(fix);
}

const HELP = `PanCode graphical application

Usage:
  pancode gui [--path </app/path>] [--open | --no-open] [--foreground]
  pancode gui background install [--handover] [--open] [--port <1-65535>]
  pancode gui background status|start|open|restart [--if-idle]|stop|uninstall
  pancode gui launcher install|status|uninstall

pancode gui opens PanCode in your browser. When this installation's
background app is installed, it reopens that app at its stable address and
returns your terminal. Otherwise it starts a private server for this terminal,
prints its launch link and opens it; press Ctrl+C to stop it.

A browser opens by itself only from an interactive terminal on a desktop.
--open always opens one, --no-open never does. --foreground always starts a
private server, and so does any of --port, --idle-exit <milliseconds>
or --log-file. --path opens a particular page. --reuse-background fails instead
of starting a private server when the background app cannot be used.
--token-stdin takes the launch token from the first line of stdin; the app on
another machine starts this one that way to drive it over SSH.

On Linux with a systemd user session, on macOS through a launchd agent and on
native Windows through a logon task, background install keeps the app at a
stable address from login, so the browser can install it as an app. That
address is 127.0.0.1:4343, or 127.0.0.1:7373 while another program holds 4343;
--port pins a different one. Background restart loads a newly installed
version; --if-idle leaves it alone while work is active. --handover transfers a
verified idle service from another installation while retaining its address and credentials. Stop
stops it until the next login or the next pancode gui, and uninstall also
removes its login, desktop and Windows entries.
Under WSL, background install also adds a PanCode Start Menu shortcut and a
sign-in entry on Windows. The shortcut wakes WSL, starts the app and brings
its window to the front, opening a Chrome or Edge app window only when none
is open; the sign-in entry only wakes WSL and starts it. pancode gui
focuses the open window the same way, and --path then shows that page in it.
On native Windows pancode gui prints the link instead of opening it unless
--open is given. Your CLI, terminal interface, headless runs, and
graphical app use the same PanCode runtime, configuration and sessions, and
the graphical app lists every project the terminal interface has worked in.
`;

export async function runGuiCommand(args: string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	try {
		const root = resolvePackageRoot();
		process.env.PANCODE_PACKAGE_ROOT = root;
		const entry = join(root, "dist/gui/server.js");
		if (!existsSync(entry)) {
			printError("The graphical application has not been built here. Run `pnpm run build` in this checkout.");
			return 2;
		}
		// A URL keeps this a separate entry; bundling it into the command chunk
		// would change import.meta.url and the worker/client paths beside it.
		const server = await import(pathToFileURL(entry).href);
		await server.main(args);
		return Number(process.exitCode ?? 0);
	} catch (error) {
		printError(error instanceof Error ? error.message : "Could not start the graphical application.");
		return 1;
	}
}

/** Separate packaged entry; inspection never starts a listener or opens a browser. */
export interface GuiUninstallPlan {
	items: Array<{ label: string; path: string }>;
	/**
	 * Graphical-application files this build can see and cannot remove, because it
	 * carries no application bundle to verify their ownership or stop their service.
	 * Uninstall reports them and leaves them, together with the state they depend on.
	 */
	unmanaged: Array<{ label: string; path: string }>;
	/** A desktop launcher another installation wrote; uninstall keeps it and the state its service may read. */
	foreign: Array<{ label: string; path: string }>;
	remove(): Promise<void>;
}

/** The command that removes what `unmanaged` lists, from a build that includes the application. */
export const GUI_UNINSTALL_ADVICE = {
	lead: "To remove them, run from a build that includes the graphical application:",
	command: "pancode gui background uninstall && pancode gui launcher uninstall",
} as const;

export async function prepareGuiUninstall(options: {
	stateDir: string;
	desktopPrefix: string;
	packageRoot?: string;
	backgroundOnly?: boolean;
}): Promise<GuiUninstallPlan> {
	// Most CLI-only installs have no web lifecycle files. Keep that path lazy,
	// including checkouts whose optional web bundle has not been built yet.
	const paths = [
		{ label: "Graphical background service", path: join(options.stateDir, "gui/background") },
		{ label: "Desktop launcher", path: join(options.desktopPrefix, "applications/dev.pancode.PanCode.desktop") },
		{
			label: "Desktop launcher ownership record",
			path: join(options.desktopPrefix, "applications/dev.pancode.PanCode.desktop.owner.json"),
		},
	];
	const present = paths.filter(({ path }, index) => {
		if (options.backgroundOnly && index !== 0) return false;
		try {
			lstatSync(path);
			return true;
		} catch (error) {
			if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
			throw error;
		}
	});
	if (!present.length)
		return {
			items: [],
			unmanaged: [],
			foreign: [],
			remove: async () => {
				const current = await prepareGuiUninstall(options);
				if (current.items.length || current.unmanaged.length || current.foreign.length)
					throw new Error("A web installation appeared during confirmation; run uninstall again.");
			},
		};
	const packageRoot = options.packageRoot ?? resolvePackageRoot();
	const entry = join(packageRoot, "dist/gui/server.js");
	// A terminal-only build has no bundle. Deleting these files blind could strand a running systemd
	// unit or remove a launcher another installation owns, so they are reported and left alone.
	if (!existsSync(entry)) return { items: [], unmanaged: present, foreign: [], remove: async () => {} };
	const server = await import(pathToFileURL(entry).href);
	const plan = await server.prepareGuiUninstall({ ...options, packageRoot });
	return { ...plan, unmanaged: [] };
}
