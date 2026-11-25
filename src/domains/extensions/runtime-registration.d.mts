// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ExtensionRuntimeDeclarationV2 } from "@pancode/sdk/pack";
import type { RuntimeRegistration } from "@pancode/sdk/testing";

export type { RuntimeRegistration };
export function createRuntimeRegistration(declaration: ExtensionRuntimeDeclarationV2): RuntimeRegistration;
