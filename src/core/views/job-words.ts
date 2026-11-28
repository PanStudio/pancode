// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** What an operator or the job tool can do to a recurring job. Browser-safe. */
const JOB_CONTROL_ACTIONS = ["pause", "resume", "cancel"] as const;
export type JobControlAction = (typeof JOB_CONTROL_ACTIONS)[number];
