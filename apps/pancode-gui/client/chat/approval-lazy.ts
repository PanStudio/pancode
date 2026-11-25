// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// The approval card and its model load beside the task screen rather than inside it: most tasks open with nothing
// waiting. The banner mounts with the screen, so its code is fetched on the first render, long before a request.
import { lazy } from "react";

const load = () => import("./Approval.js");

export const ApprovalBanner = lazy(() => load().then((module) => ({ default: module.ApprovalBanner })));
export const AnchoredApproval = lazy(() => load().then((module) => ({ default: module.AnchoredApproval })));
