// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export const TURN_CONTROL_HOOKS = ["detached-collection"] as const;
export type TurnControlHook = (typeof TURN_CONTROL_HOOKS)[number];

export interface TurnControlSettings {
	hooks: TurnControlHook[];
}
