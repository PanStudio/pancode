// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export { type DoctorFinding, formatDoctorReport, runDoctor } from "./doctor.js";
export { type Installation, inspectInstallation } from "./install-method.js";
export {
	planSelfUpgrade,
	runApprovedSelfUpgrade,
	type SelfUpgradePlan,
} from "./self-upgrade.js";
export {
	ensurePancodeState,
	readStateInfo,
	type StateInfo,
	takeContainedYoloNotice,
	takeUpgradeNotice,
	type UpgradeTransition,
} from "./state.js";
export { describeUpgradeNotice } from "./upgrade-notice.js";
export { getVersionInfo, type VersionInfo } from "./version.js";
