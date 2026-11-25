// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { AppProblem } from "../services/problem.js";
import { projectSessionConfigOptions } from "./session-config-model.js";

export function projectConfigOptions(raw: unknown) {
	const options = projectSessionConfigOptions(raw);
	if (options === null) throw new AppProblem("upstream_acp", "PanCode returned invalid session configuration.");
	return options;
}
