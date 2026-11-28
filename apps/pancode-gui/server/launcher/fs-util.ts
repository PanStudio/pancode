// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createHash } from "node:crypto";

export const sha256Hex = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
export const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
