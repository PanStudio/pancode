// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Every decision point. Adding one is a module here, one export below and one `ask` at a place that already waits. */

export { boundedHead, boundedTail, probability } from "./bounds.js";
export type {
	ConsultFilterMatch,
	ConsultFilterObject,
	ConsultFilterValue,
	ConsultObject,
	ConsultReading,
	ConsultValue,
} from "./consult.js";
export {
	CONSULT_FILTER_MAX_CHARS,
	CONSULT_MAX_FILE_CHARS,
	consultFilterPoint,
	consultPoint,
	fitFilterItems,
	smallestRequestWindow,
} from "./consult.js";
export type { JudgeScreenObject, JudgeScreenResult, JudgeScreenValue } from "./judge-screen.js";
export {
	JUDGE_SCREEN_POINT,
	judgeScreenResults,
} from "./judge-screen.js";
export type { TriageObject, TriagePick, TriageValue } from "./triage.js";
export { triagePoint } from "./triage.js";
