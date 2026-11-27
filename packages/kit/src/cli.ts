#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The source-run `pankit`: PanCode serves its built-in servers through this file when it runs from source. */
import { runPankit } from "./pankit.js";

runPankit(process.argv.slice(2)).then((code) => {
	process.exitCode = code;
});
