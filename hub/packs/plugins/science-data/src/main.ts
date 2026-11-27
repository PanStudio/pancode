// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The entry `pnpm run hub:pin` bundles into `server.mjs`: the `catalog` server on stdio. */
import { serveStdio } from "pancode/sdk/mcp-server";
import { server } from "./server.js";

await serveStdio(server);
