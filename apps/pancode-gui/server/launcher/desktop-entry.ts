// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { isAbsolute } from "node:path";

export const launcherId = "dev.pancode.PanCode";
export const launcherUnsupported =
	"Desktop installation is currently supported on Linux only. Start the server with --open, or open its printed URL, on this platform.";

/** Exec has freedesktop quoting, not shell quoting; percent signs are field codes even inside quotes. */
export function desktopArgument(value: string) {
	if ([...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
		throw new Error("Desktop entry paths cannot contain control characters.");
	return `"${value.replace(/\\/g, "\\\\\\\\").replace(/["`$]/g, "\\\\$&").replace(/%/g, "%%")}"`;
}
export type LaunchPaths = { node: string; loader?: string; entry: string; icon?: string; background?: string };
export function desktopEntry(paths: LaunchPaths) {
	if (!Object.values(paths).every(isAbsolute)) throw new Error("Launcher paths must be absolute.");
	if (paths.background !== undefined && !isAbsolute(paths.background))
		throw new Error("Background directory must be absolute.");
	if (paths.icon) desktopArgument(paths.icon);
	const argv = [
		paths.node,
		...(paths.loader ? ["--import", paths.loader] : []),
		paths.entry,
		...(paths.background ? ["background", "open", "--directory", paths.background] : ["--open", "--idle-exit", "60000"]),
	];
	return [
		"[Desktop Entry]",
		"Type=Application",
		"Name=PanCode",
		"Comment=Build and explore with PanCode",
		`Exec=${argv.map(desktopArgument).join(" ")}`,
		`Icon=${paths.icon ? paths.icon.replace(/\\/g, "\\\\") : "applications-development"}`,
		"Terminal=false",
		"Categories=Development;",
		"Keywords=PanCode;AI;Coding;",
		"StartupNotify=false",
		"",
	].join("\n");
}
