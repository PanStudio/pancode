// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export type { ProgramFetcher, ProgramInstallResult } from "./install.js";
export { installPinnedProgram, installProgram } from "./install.js";
export { programsRoot, programVersionDir } from "./paths.js";
export {
	currentProgramPlatform,
	findPinnedProgram,
	PINNED_PROGRAMS,
} from "./registry.js";
export { installedProgramVersions, removeProgram } from "./remove.js";
export {
	describeFloorRejection,
	describeResolution,
	installRemedy,
	pinnedProgramMissing,
	programStatus,
	programStatuses,
	resolvePinnedEntryBinary,
	resolveProgramBinary,
	resolveVendoredBinary,
} from "./resolve.js";
export type {
	PinnedProgram,
	PinnedProgramDownload,
	ProgramPlatform,
	ProgramResolution,
	ProgramStatus,
} from "./types.js";
