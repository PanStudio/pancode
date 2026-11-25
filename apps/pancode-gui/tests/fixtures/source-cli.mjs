#!/usr/bin/env node
/**
 * The checkout's CLI run from source. Tests that compare the server with "the canonical CLI" point both
 * sides here, so they exercise the code under test rather than whatever `dist/` or `pancode` on PATH
 * happens to hold, and they need no build. tsx reads the checkout's tsconfig explicitly: the CLI runs in a
 * scratch home with no tsconfig of its own, and the workspace packages (`@pancode/store`, `@pancode/scidata`)
 * resolve only through its `paths`.
 */
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

register({ tsconfig: fileURLToPath(new URL("../../../../tsconfig.json", import.meta.url)) });
await import("../../../../src/cli/index.ts");
