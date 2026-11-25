// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Type } from "typebox";
import { AcpTarget } from "./wire.js";

export { AcpTargetProbe as TargetProbe } from "./wire.js";

export const SessionTargets = Type.Object(
	{
		targets: Type.Array(Type.Pick(AcpTarget, ["id", "runtime", "models", "thinkingLevels", "isOrchestrator"]), {
			maxItems: 64,
		}),
		truncated: Type.Boolean(),
	},
	{ additionalProperties: false },
);
