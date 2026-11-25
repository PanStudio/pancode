// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export { type CampaignMetrics, foldCampaignMetrics, loadCampaignMetrics } from "./fold.js";
export { loadRoster, parseRoster, type RosterEntry } from "./roster.js";
export {
	CAMPAIGN_SCHEMA_VERSION,
	type CampaignEntryResult,
	type CampaignEntryStatus,
	type CampaignInput,
	CampaignInputError,
	type CampaignProbe,
	type CampaignProbeResult,
	type CampaignResult,
	runCampaign,
	validateCampaignInput,
} from "./runner.js";
