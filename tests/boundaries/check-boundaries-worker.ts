// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Runs the boundary check off the main thread, so check-hygiene overlaps it with its other checks.
import { parentPort, workerData } from "node:worker_threads";
import { runBoundaryCheck } from "./check-boundaries.js";

parentPort?.postMessage(runBoundaryCheck(workerData as string).violations);
