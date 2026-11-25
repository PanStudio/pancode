// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import {
	ProblemReportBundle,
	ProblemReportBundleRequest,
	ProblemReportChoices,
	ProblemReportDraftParams,
	ProblemReportEdits,
	ProblemReportOffer,
	ProblemReportOfferRequest,
	ProblemReportPlanRequest,
	ProblemReportRows,
	ProblemReportSent,
	ProblemReportView,
} from "./problem-reports.js";
import { UsageReport } from "./reports.js";
import { defineRoute, get, operationParams, post } from "./route-schema.js";
import { routes as runtimeRoutes } from "./runtime-routes.js";

/** Usage reports and problem reports. */
export const reportRoutes = {
	usage: defineRoute({
		...get,
		params: operationParams,
		response: UsageReport,
		summary: "Canonical usage report for the last 30 days",
		...runtimeRoutes.usage,
	}),
	installationUsage: defineRoute({
		...get,
		response: UsageReport,
		summary: "The same usage report across every project, with no workspace open",
		...runtimeRoutes.installationUsage,
	}),
	problemReports: defineRoute({
		...get,
		params: operationParams,
		response: ProblemReportRows,
		summary: "Problem reports on this machine: drafts and what was sent",
		...runtimeRoutes.problemReports,
	}),
	problemReportPlan: defineRoute({
		...post,
		status: 200,
		params: operationParams,
		body: ProblemReportPlanRequest,
		response: ProblemReportView,
		summary: "Start a problem report draft and return the exact text sending would post; sends nothing",
		...runtimeRoutes.problemReportPlan,
	}),
	problemReportUpdate: defineRoute({
		...post,
		status: 200,
		params: ProblemReportDraftParams,
		body: ProblemReportEdits,
		response: ProblemReportView,
		summary: "Edit a problem report draft and re-plan it on the host; sends nothing",
		...runtimeRoutes.problemReportUpdate,
	}),
	problemReportSend: defineRoute({
		...post,
		status: 200,
		params: ProblemReportDraftParams,
		body: ProblemReportChoices,
		response: ProblemReportSent,
		summary: "Send a reviewed problem report draft; requires consent from the dialog's Send button",
		...runtimeRoutes.problemReportSend,
	}),
	problemReportBundle: defineRoute({
		...post,
		status: 200,
		params: ProblemReportDraftParams,
		body: ProblemReportBundleRequest,
		response: ProblemReportBundle,
		summary: "Build a draft's diagnostic bundle for review without writing or attaching it",
		...runtimeRoutes.problemReportBundle,
	}),
	problemReportOffer: defineRoute({
		...post,
		status: 200,
		params: operationParams,
		body: ProblemReportOfferRequest,
		response: ProblemReportOffer,
		summary: "Whether the report offer rules allow suggesting a report for this session now",
		...runtimeRoutes.problemReportOffer,
	}),
};
