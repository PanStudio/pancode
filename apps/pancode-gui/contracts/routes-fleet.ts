// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Type } from "typebox";
import {
	ArenaMatch,
	ArenaMatches,
	ArenaMatchId,
	ArenaStandings,
	ArenaStandingsQuery,
	ArenaStartRequest,
	ArenaVote,
	ArenaVoteRequest,
} from "./arena.js";
import { Id } from "./common.js";
import { EvidenceDetail, EvidencePage } from "./evidence.js";
import {
	Councils,
	DispatchRun,
	DispatchRuns,
	FleetGates,
	FleetPageQuery,
	FleetRootDetail,
	FleetRoots,
	FleetRunRecord,
} from "./fleet.js";
import { Accepted } from "./operations.js";
import {
	ResearchCampaign,
	ResearchCampaignId,
	ResearchCampaigns,
	ResearchReport,
	ResearchStartRequest,
} from "./research.js";
import { defineRoute, get, operationParams, post } from "./route-schema.js";
import { routes as runtimeRoutes } from "./runtime-routes.js";

/** Arena matches, research campaigns, run evidence and the fleet's runs, dispatches, councils and gates. */
export const fleetRoutes = {
	arenaMatches: defineRoute({
		...get,
		params: operationParams,
		response: ArenaMatches,
		summary: "Arena matches in this workspace, newest first; identities appear only for voted matches.",
		...runtimeRoutes.arenaMatches,
	}),
	arenaMatch: defineRoute({
		...get,
		params: Type.Object({ id: Id, matchId: ArenaMatchId }, { additionalProperties: false }),
		response: ArenaMatch,
		summary: "One arena match, blind until it has a vote and revealed after.",
		...runtimeRoutes.arenaMatch,
	}),
	arenaStandings: defineRoute({
		...get,
		params: operationParams,
		query: ArenaStandingsQuery,
		response: ArenaStandings,
		summary: "Win, loss and tie counts from recorded votes, with an Elo rating once enough votes exist.",
		...runtimeRoutes.arenaStandings,
	}),
	arenaStart: defineRoute({
		...post,
		params: operationParams,
		body: ArenaStartRequest,
		response: Accepted,
		summary: "Run one prompt on 2 to 4 contenders in isolated worktrees as a cancellable operation.",
		...runtimeRoutes.arenaStart,
	}),
	arenaVote: defineRoute({
		...post,
		status: 200,
		params: Type.Object({ id: Id, matchId: ArenaMatchId }, { additionalProperties: false }),
		body: ArenaVoteRequest,
		response: ArenaVote,
		summary: "Record the human's blind vote for a finished match; a second vote must replace explicitly.",
		...runtimeRoutes.arenaVote,
	}),
	researchCampaigns: defineRoute({
		...get,
		params: operationParams,
		response: ResearchCampaigns,
		summary: "Research campaigns in this workspace, newest first, with their objective, stop reason and ratchets.",
		...runtimeRoutes.researchCampaigns,
	}),
	researchCampaign: defineRoute({
		...get,
		params: Type.Object({ id: Id, campaignId: ResearchCampaignId }, { additionalProperties: false }),
		response: ResearchCampaign,
		summary: "One research campaign: its frozen objective, the A/A check and every iteration as journaled.",
		...runtimeRoutes.researchCampaign,
	}),
	researchReport: defineRoute({
		...get,
		params: Type.Object({ id: Id, campaignId: ResearchCampaignId }, { additionalProperties: false }),
		response: ResearchReport,
		summary: "Regrade every measurement of a campaign from its raw samples and say whether each agrees with the journal.",
		...runtimeRoutes.researchReport,
	}),
	researchStart: defineRoute({
		...post,
		params: operationParams,
		body: ResearchStartRequest,
		response: Accepted,
		summary:
			"Run a research hill climb in isolated worktrees as a cancellable operation; cancelling stops it like Ctrl-C.",
		...runtimeRoutes.researchStart,
	}),
	evidenceList: defineRoute({
		...get,
		query: FleetPageQuery,
		response: EvidencePage,
		summary: "Paginated finished runs with their sealed assessments and trust verdicts",
		...runtimeRoutes.evidenceList,
	}),
	evidenceDetail: defineRoute({
		...get,
		params: operationParams,
		response: EvidenceDetail,
		summary: "A run's sealed findings, canonical trust, admitted provenance and gate verdicts",
		...runtimeRoutes.evidenceDetail,
	}),
	runRecordVerify: defineRoute({
		...post,
		params: Type.Object({ id: Id, runId: Id }, { additionalProperties: false }),
		response: Accepted,
		summary: "Recheck record integrity against its run through PanCode",
		...runtimeRoutes.runRecordVerify,
	}),
	fleetRoots: defineRoute({
		...get,
		response: FleetRoots,
		summary: "Paginated durable fleet roots",
		query: FleetPageQuery,
		...runtimeRoutes.fleetRoots,
	}),
	fleetRoot: defineRoute({
		...get,
		response: FleetRootDetail,
		summary: "Fleet plan results, record and related topology",
		params: operationParams,
		...runtimeRoutes.fleetRoot,
	}),
	dispatchRuns: defineRoute({
		...get,
		response: DispatchRuns,
		summary: "Paginated durable dispatch runs",
		query: FleetPageQuery,
		...runtimeRoutes.dispatchRuns,
	}),
	dispatchRun: defineRoute({
		...get,
		response: DispatchRun,
		summary: "One durable dispatch run",
		params: operationParams,
		...runtimeRoutes.dispatchRun,
	}),
	fleetRunRecord: defineRoute({
		...get,
		query: Type.Object({ include: Type.Optional(Type.Literal("full")) }, { additionalProperties: false }),
		response: FleetRunRecord,
		summary: "Run record evidence by run identifier, checked against its seal; the saved document on request",
		params: operationParams,
		...runtimeRoutes.fleetRunRecord,
	}),
	fleetCouncils: defineRoute({
		...get,
		response: Councils,
		summary: "Canonical bounded council topology",
		...runtimeRoutes.fleetCouncils,
	}),
	fleetGates: defineRoute({
		...get,
		response: FleetGates,
		summary: "Canonical verified gate decision topology",
		...runtimeRoutes.fleetGates,
	}),
};
