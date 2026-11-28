// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { stripLicenseHeader } from "../../scripts/license-headers.mjs";
import { REPORT_BUNDLE_ENVELOPE_SCHEMA } from "../../src/domains/report/bundle.js";
import { closedSchemaErrors, shareProjectionErrors } from "../../src/domains/telemetry/share-soundness.js";
import { LAYER_EXEMPTIONS } from "./layer-exemptions.js";

export interface BoundaryCheckResult {
	violations: string[];
}

// The per-file rules run back to back on one file; they share its read-only
// syntax tree instead of each parsing it again.
let lastParsed: { file: string; source: string; tree: ts.SourceFile } | undefined;
function parseTree(file: string, source: string): ts.SourceFile {
	if (lastParsed?.file === file && lastParsed.source === source) return lastParsed.tree;
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	lastParsed = { file, source, tree };
	return tree;
}

/** Provider usage in messages/ledger payloads is immutable outside engine adapters (#434). */
export function checkLedgerUsageMutation(file: string, source: string): string[] {
	if (file.startsWith("src/engine/")) return [];
	const tree = parseTree(file, source);
	const aliases = new Set<string>();
	const wholeAliases = new Set<string>();
	const unwrap = (node: ts.Expression): ts.Expression => {
		while (
			ts.isAsExpression(node) ||
			ts.isTypeAssertionExpression(node) ||
			ts.isParenthesizedExpression(node) ||
			ts.isNonNullExpression(node)
		)
			node = node.expression;
		return node;
	};
	const property = (node: ts.Expression): string | undefined => {
		node = unwrap(node);
		return ts.isPropertyAccessExpression(node)
			? node.name.text
			: ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
				? node.argumentExpression.text
				: undefined;
	};
	const providerUsage = (input: ts.Expression): boolean => {
		const node = unwrap(input);
		if (ts.isIdentifier(node)) return aliases.has(node.text);
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
			return providerUsage(node.left);
		if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
		return (
			(property(node) === "usage" && /message|payload|\braw\b/i.test(node.expression.getText(tree))) ||
			providerUsage(node.expression)
		);
	};
	const collect = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			providerUsage(node.initializer)
		) {
			aliases.add(node.name.text);
			const value = unwrap(node.initializer);
			if (property(value) === "usage" || (ts.isIdentifier(value) && wholeAliases.has(value.text)))
				wholeAliases.add(node.name.text);
		}
		if (
			ts.isVariableDeclaration(node) &&
			ts.isObjectBindingPattern(node.name) &&
			node.initializer &&
			/message|payload|\braw\b/i.test(node.initializer.getText(tree))
		) {
			for (const binding of node.name.elements) {
				if (ts.isIdentifier(binding.name) && (binding.propertyName?.getText(tree) ?? binding.name.text) === "usage") {
					aliases.add(binding.name.text);
					wholeAliases.add(binding.name.text);
				}
			}
		}
		ts.forEachChild(node, collect);
	};
	collect(tree);
	const violations: string[] = [];
	const report = (node: ts.Node) =>
		violations.push(
			`rule12: ${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1} mutates provider usage; keep PanCode accounting beside the raw usage and link the call journal`,
		);
	const visit = (node: ts.Node): void => {
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
			node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
		) {
			const target = unwrap(node.left);
			if ((ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) && providerUsage(target)) {
				// The P0 never-sent contract stores null; direct copies preserve provider bytes (#434).
				const copy =
					property(target) === "usage" &&
					node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
					(node.right.kind === ts.SyntaxKind.NullKeyword ||
						(property(node.right) === "usage" && providerUsage(node.right)) ||
						(ts.isIdentifier(unwrap(node.right)) && wholeAliases.has(unwrap(node.right).getText(tree))));
				if (!copy) report(node);
			}
		}
		if (
			(ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
			(node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
			providerUsage(node.operand)
		)
			report(node);
		if (
			ts.isCallExpression(node) &&
			node.expression.getText(tree) === "Object.assign" &&
			node.arguments[0] &&
			/message|payload|\braw\b/i.test(node.arguments[0].getText(tree))
		) {
			for (const argument of node.arguments.slice(1)) {
				if (
					ts.isObjectLiteralExpression(argument) &&
					argument.properties.some(
						(field) =>
							ts.isPropertyAssignment(field) &&
							field.name.getText(tree).replace(/["']/g, "") === "usage" &&
							field.initializer.kind !== ts.SyntaxKind.NullKeyword,
					)
				)
					report(argument);
			}
		}
		if (ts.isDeleteExpression(node) && providerUsage(node.expression)) report(node);
		if (
			ts.isCallExpression(node) &&
			node.expression.getText(tree) === "Object.assign" &&
			node.arguments[0] &&
			providerUsage(node.arguments[0])
		)
			report(node);
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return violations;
}

/** A key that counts tokens, prices them or annotates their accounting; the provider's own `usage` is not one. */
const USAGE_SHAPED_KEY = /^(?:usage.+|tokens?|cost.*|usd|.+(?:Usage|Tokens|TokenCount|Cost|Usd|Accounting))$/;
/** The modules that build session-ledger message payloads. */
const LEDGER_PAYLOAD_ROOTS = ["src/session-control/", "src/domains/session/"];

/** The ledger is the conversation record and the journal owns usage, so no payload gains a usage-shaped key (#434 §5.1, §5.3). */
export function checkLedgerUsageKeys(file: string, source: string): string[] {
	if (!LEDGER_PAYLOAD_ROOTS.some((root) => file.startsWith(root))) return [];
	const tree = parseTree(file, source);
	const payloadLike = (node: ts.Node) => /payload/i.test(node.getText(tree));
	const keyOf = (name: ts.Node): string | undefined =>
		ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) ? name.text : undefined;
	const violations: string[] = [];
	const report = (node: ts.Node, key: string) =>
		violations.push(
			`rule12: ${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1} puts usage-shaped ${key} on a ledger payload; the ledger is the conversation record and the call journal owns usage`,
		);
	const literalKeys = (literal: ts.ObjectLiteralExpression) => {
		for (const field of literal.properties) {
			const key = field.name && keyOf(field.name);
			if (key !== undefined && USAGE_SHAPED_KEY.test(key)) report(field, key);
		}
	};
	const visit = (node: ts.Node): void => {
		// payload.key = ... and payload["key"] = ...
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			(ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
			payloadLike(node.left.expression)
		) {
			const key = ts.isPropertyAccessExpression(node.left) ? node.left.name.text : keyOf(node.left.argumentExpression);
			if (key !== undefined && USAGE_SHAPED_KEY.test(key)) report(node, key);
		}
		// payload: { key: ... } and const payload = { key: ... }
		if (
			(ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)) &&
			node.initializer &&
			ts.isObjectLiteralExpression(node.initializer) &&
			payloadLike(node.name)
		)
			literalKeys(node.initializer);
		// Object.assign(payload, { key: ... })
		if (
			ts.isCallExpression(node) &&
			node.expression.getText(tree) === "Object.assign" &&
			node.arguments[0] &&
			payloadLike(node.arguments[0])
		)
			for (const argument of node.arguments.slice(1)) if (ts.isObjectLiteralExpression(argument)) literalKeys(argument);
		// for (const key of ["usage", ...]) payload[key] = ...: the copy list names the keys a payload keeps.
		if (
			ts.isForOfStatement(node) &&
			ts.isArrayLiteralExpression(node.expression) &&
			ts.isVariableDeclarationList(node.initializer)
		) {
			const loopKey = node.initializer.declarations[0]?.name.getText(tree);
			const copies = (child: ts.Node): boolean =>
				(ts.isElementAccessExpression(child) &&
					payloadLike(child.expression) &&
					child.argumentExpression.getText(tree) === loopKey) ||
				ts.forEachChild(child, copies) === true;
			if (loopKey !== undefined && copies(node.statement))
				for (const element of node.expression.elements)
					if (ts.isStringLiteral(element) && USAGE_SHAPED_KEY.test(element.text)) report(element, element.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return violations;
}

/**
 * Names that carry a domain owner's capability, by owning domain (rule17): the
 * middleware registrar installs executable hooks, and the telemetry binder
 * points the shared run projection at live readers. Neither is on a contract.
 */
const OWNER_CAPABILITIES: ReadonlyMap<string, string> = new Map([
	["MiddlewareRegistrar", "middleware"],
	["MiddlewareHost", "middleware"],
	["MiddlewareBundle", "middleware"],
	["MiddlewareDomain", "middleware"],
	["createMiddlewareDomain", "middleware"],
	["createMiddlewareBundle", "middleware"],
	["createMiddlewareHostFromSnapshot", "middleware"],
	["TelemetryRunReaderBinder", "telemetry"],
	["TelemetryBundle", "telemetry"],
	["TelemetryDomain", "telemetry"],
	["createTelemetryDomain", "telemetry"],
	["createTelemetryBundle", "telemetry"],
]);

/**
 * Files outside the owning domain that hold its capability, keyed
 * `file#domain` (rule17). The loader publishes only contracts; a composition
 * that owns the domain keeps the capability and hands it to its collaborators.
 */
const OWNER_CAPABILITY_HOLDERS: ReadonlyMap<string, string> = new Map([
	["src/entry/orchestrator.ts#middleware", "the interactive composition root owns the middleware domain"],
	["src/entry/extension-reload.ts#middleware", "replaces registrations for the orchestrator on reload"],
	["src/entry/worker-hook-host.ts#middleware", "registers extension hooks for the orchestrator's worker host"],
	["src/cli/worker-extension-hooks.ts#middleware", "the headless and fleet composition owns its middleware domain"],
	["src/engine/worker-tools.ts#middleware", "the worker builds its own host from the parent's snapshot"],
	["src/session-control/chat-loop.ts#middleware", "receives registerHook from the orchestrator as a dependency"],
	["src/entry/orchestrator.ts#telemetry", "the interactive composition root owns the telemetry domain"],
	["src/interactive/interactive-deps.ts#telemetry", "carries the orchestrator's binder to the presentation"],
	["src/interactive/interactive-presentation.ts#telemetry", "binds the terminal's live run readers for its lifetime"],
]);

/**
 * A published contract carries no registration capability, and its type comes
 * from DomainContractMap, never from the caller (rule17).
 */
export function checkDomainContractAccess(file: string, source: string, usedHolders?: Set<string>): string[] {
	const tree = parseTree(file, source);
	const violations: string[] = [];
	const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const visit = (node: ts.Node): void => {
		const owner = ts.isIdentifier(node) ? OWNER_CAPABILITIES.get(node.text) : undefined;
		if (owner !== undefined && !file.startsWith(`src/domains/${owner}/`)) {
			const holder = `${file}#${owner}`;
			if (OWNER_CAPABILITY_HOLDERS.has(holder)) usedHolders?.add(holder);
			else
				violations.push(
					`rule17: ${file}:${line(node)} names ${(node as ts.Identifier).text}; only a composition that owns the ${owner} domain holds it (OWNER_CAPABILITY_HOLDERS)`,
				);
		}
		if (
			ts.isCallExpression(node) &&
			node.typeArguments !== undefined &&
			(ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(tree)) ===
				"getContract"
		) {
			violations.push(
				`rule17: ${file}:${line(node)} passes a type argument to getContract; the contract type comes from DomainContractMap`,
			);
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return violations;
}

/** Applied to the producer's complete local value-import closure, including helper modules (#434). */
export function checkTelemetryProducer(file: string, source: string): string[] {
	const tree = parseTree(file, source);
	const violations: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
			const specifier = node.moduleSpecifier.text;
			if (
				/^(?:node:)?(?:fs(?:\/promises)?|sqlite)$/.test(specifier) ||
				/state-file-lock|safe-resource-write/.test(specifier)
			) {
				violations.push(`rule13: ${file} imports persistence on the telemetry producer path (${specifier})`);
			}
		}
		if (
			(ts.isCallExpression(node) || ts.isNewExpression(node)) &&
			/^(?:JSON\.stringify|(?:\w+\.)?(?:appendFileSync|writeSync|DatabaseSync))$/.test(node.expression.getText(tree))
		) {
			violations.push(`rule13: ${file} serializes or performs synchronous I/O on the telemetry producer path`);
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return violations;
}

/**
 * A path under the telemetry root, as a path expression spells it: a literal `telemetry` segment, or a helper from
 * src/domains/telemetry/paths.ts, the one module that builds those paths (`telemetryRoot`, `telemetryRunDirectory`,
 * `telemetryJournalPath`, ...).
 */
const TELEMETRY_PATH = /[/"'`](telemetry)(?=[/"'`])|\b(telemetry\w*(?:Root|Directory|Path))\b/;
/** The write call and which of its arguments name a path it writes, creates, moves or removes. */
const PATH_WRITES = new Map<string, number[]>([
	...["writeFile", "appendFile", "createWriteStream", "rm", "rmdir", "unlink", "truncate", "mkdir"].flatMap(
		(name): [string, number[]][] => [
			[name, [0]],
			[`${name}Sync`, [0]],
		],
	),
	...["rename", "copyFile", "cp", "symlink", "link"].flatMap((name): [string, number[]][] => [
		[name, [0, 1]],
		[`${name}Sync`, [0, 1]],
	]),
	["safeResourceWrite", [0]],
	["safeResourceWriteAsync", [0]],
]);

/** Only the telemetry domain writes under the telemetry root; every other module goes through its writers (#434 §5.1). */
export function checkTelemetryWrites(file: string, source: string): string[] {
	if (file.startsWith("src/domains/telemetry/")) return [];
	const tree = parseTree(file, source);
	// A path is usually built a step or two before the write, so a name expands to what this file assigns it.
	const definitions = new Map<string, ts.Node[]>();
	const define = (name: string, node: ts.Node) => definitions.set(name, [...(definitions.get(name) ?? []), node]);
	const collect = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
			define(node.name.text, node.initializer);
		if (ts.isFunctionDeclaration(node) && node.name && node.body) define(node.name.text, node.body);
		ts.forEachChild(node, collect);
	};
	collect(tree);
	const expand = (node: ts.Node, seen: Set<string>): string => {
		let text = node.getText(tree);
		const visit = (child: ts.Node): void => {
			if (ts.isIdentifier(child) && !seen.has(child.text) && seen.size < 8) {
				seen.add(child.text);
				for (const definition of definitions.get(child.text) ?? []) text += ` ${expand(definition, seen)}`;
			}
			ts.forEachChild(child, visit);
		};
		visit(node);
		return text;
	};
	const violations: string[] = [];
	const visit = (node: ts.Node): void => {
		let paths: ts.Expression[] = [];
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText(tree);
			const positions = PATH_WRITES.get(name);
			if (positions) paths = positions.flatMap((index) => node.arguments[index] ?? []);
			// open() writes only with a flag that is not read-only.
			const flags = node.arguments[1];
			if (
				(name === "open" || name === "openSync") &&
				flags &&
				!(ts.isStringLiteral(flags) && /^rs?$/.test(flags.text)) &&
				!/RDONLY/.test(flags.getText(tree))
			)
				paths = [node.arguments[0] as ts.Expression];
		}
		if (
			ts.isNewExpression(node) &&
			node.expression.getText(tree) === "DatabaseSync" &&
			node.arguments?.[0] &&
			!/readOnly:\s*true/.test(node.arguments[1]?.getText(tree) ?? "")
		)
			paths = [node.arguments[0]];
		for (const target of paths) {
			const match = TELEMETRY_PATH.exec(expand(target, new Set()));
			if (!match) continue;
			const spelled = match[1] ?? match[2];
			const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
			violations.push(
				`rule11: ${file}:${line} writes under the telemetry root (${spelled}) outside the telemetry domain; go through the telemetry writers`,
			);
			break;
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return violations;
}

/** Guard monetary presentation without confusing token/duration precision or shell dollars (#434). */
export function checkCostRendering(file: string, source: string): string[] {
	if (file === "src/core/telemetry/render.ts") return [];
	const tree = parseTree(file, source);
	const violations: string[] = [];
	const monetary = /cost|usd|price|spend|amount|dollars|ceiling|budget/i;
	const visit = (node: ts.Node) => {
		let bypass = false;
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const method = node.expression;
			bypass =
				["toFixed", "toPrecision", "toLocaleString"].includes(method.name.text) &&
				monetary.test(
					ts.isPropertyAccessExpression(method.expression) ? method.expression.name.text : method.expression.getText(tree),
				) &&
				!/tokens|calls|bytes|percent|ms$/i.test(method.expression.getText(tree));
		}
		if (ts.isTemplateExpression(node)) {
			let prefix = node.head.text;
			for (const span of node.templateSpans) {
				const expression = span.expression.getText(tree);
				if (
					prefix.endsWith("$") &&
					(monetary.test(expression) || /\.(?:toFixed|toPrecision|toLocaleString)\(/.test(expression))
				)
					bypass = true;
				prefix = span.literal.text;
			}
		}
		if (
			ts.isPropertyAssignment(node) &&
			node.name.getText(tree) === "style" &&
			ts.isStringLiteral(node.initializer) &&
			node.initializer.text === "currency"
		)
			bypass = true;
		if (ts.isStringLiteral(node) && (/^\$\d+\.\d+(?: local)?$/.test(node.text) || /^cost unknown$/i.test(node.text)))
			bypass = true;
		if (bypass) {
			const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
			violations.push(
				`rule10: ${file}:${line} formats money outside core/telemetry/render.ts; use the canonical renderer (renderPricing, renderUsdSum or a DTO display), or a server-rendered GUI display string`,
			);
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return [...new Set(violations)];
}

/** The surfaces whose token and cost figures must be the read model's folds (#434 §11.3). */
const SURFACE_TOTAL_ROOTS = ["src/interactive/", "src/engine/acp/", "src/cli/"];
/**
 * Functions on those surfaces that still fold token or cost fields, each with the reason it may. An exemption that
 * no longer matches a fold fails, so the list only shrinks.
 */
const SURFACE_TOTAL_EXEMPTIONS: ReadonlyArray<{ file: string; functions: readonly string[]; reason: string }> = [
	{
		file: "src/engine/acp/server-tool-updates.ts",
		functions: ["handleChatEvent"],
		reason: "an ACP prompt's output tokens over its generation time make its tok/s rate, a division over measured facts",
	},
	{
		file: "src/interactive/context-bar.ts",
		functions: ["buildSegmentedContextBar"],
		reason:
			"context-window occupancy from the context ledger's estimate, not spend: pending user text joins the conversation segment",
	},
	{
		file: "src/interactive/footer/context-rail.ts",
		functions: ["contextBreakdownForBar"],
		reason:
			"context-window occupancy from the context ledger's estimate, not spend: pending user text joins the conversation segment",
	},
];

const USAGE_FIELD = /^(?:input|output|cacheRead|cacheWrite|cacheWrite1h|reasoning)$/;
const TOTAL_NAME = /^(?:tokens|tokenCount|usd)$|(?:Tokens|TokenCount|Usd)$/;

/**
 * A surface sums no token or cost field, including a FactSum's known parts: no `+=`, self-adding assignment, `field: prev.field + x` fold or `.reduce`
 * over one (#434 §11.3). A bare `input`/`output` identifier is not a field, so string building does not trip it.
 */
export function checkSurfaceTotals(file: string, source: string, used?: Set<string>): string[] {
	if (!SURFACE_TOTAL_ROOTS.some((root) => file.startsWith(root))) return [];
	const tree = parseTree(file, source);
	const violations: string[] = [];
	const unwrap = (node: ts.Expression): ts.Expression => {
		while (
			ts.isAsExpression(node) ||
			ts.isParenthesizedExpression(node) ||
			ts.isNonNullExpression(node) ||
			(ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
		)
			node = ts.isBinaryExpression(node) ? node.left : node.expression;
		return node;
	};
	const field = (node: ts.Node): string | undefined =>
		ts.isPropertyAccessExpression(node)
			? node.name.text
			: ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
				? node.argumentExpression.text
				: undefined;
	const total = (input: ts.Expression): boolean => {
		const node = unwrap(input);
		const name = field(node);
		if (name !== undefined) return TOTAL_NAME.test(name) || USAGE_FIELD.test(name);
		return ts.isIdentifier(node) && TOTAL_NAME.test(node.text);
	};
	const readsTotal = (node: ts.Node): boolean => {
		const name = field(node);
		if (name !== undefined && (TOTAL_NAME.test(name) || USAGE_FIELD.test(name))) return true;
		if (ts.isIdentifier(node) && TOTAL_NAME.test(node.text)) return true;
		return ts.forEachChild(node, (child) => readsTotal(child) || undefined) === true;
	};
	const owner = (node: ts.Node): string => {
		for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
			if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name) return at.name.getText(tree);
			if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && ts.isVariableDeclaration(at.parent))
				return at.parent.name.getText(tree);
		}
		return "<module>";
	};
	const report = (node: ts.Node) => {
		const fn = owner(node);
		const exemption = SURFACE_TOTAL_EXEMPTIONS.find((entry) => entry.file === file && entry.functions.includes(fn));
		if (exemption) {
			used?.add(`${file}#${fn}`);
			return;
		}
		const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
		violations.push(
			`rule14: ${file}:${line} sums a token or cost field in ${fn}; show the read model's quantity display instead, or exempt the function with its reason in SURFACE_TOTAL_EXEMPTIONS`,
		);
	};
	const adds = (node: ts.Expression, target: (operand: ts.Expression) => boolean): boolean => {
		const sum = unwrap(node);
		return (
			ts.isBinaryExpression(sum) &&
			sum.operatorToken.kind === ts.SyntaxKind.PlusToken &&
			(target(sum.left) || target(sum.right) || adds(sum.left, target))
		);
	};
	// `a[k] = (a[k] ?? 0) + (b[k] ?? 0)` folds one record into another field by field under a key no name test can
	// read, as a loop over a list of usage fields does (#434).
	const mergesComputedKey = (target: ts.Expression, sum: ts.Expression): boolean => {
		const left = unwrap(target);
		if (!ts.isElementAccessExpression(left) || ts.isStringLiteral(left.argumentExpression)) return false;
		const key = left.argumentExpression.getText(tree);
		const receiver = left.expression.getText(tree);
		return adds(sum, (operand) => {
			const read = unwrap(operand);
			return (
				ts.isElementAccessExpression(read) &&
				read.argumentExpression.getText(tree) === key &&
				read.expression.getText(tree) !== receiver
			);
		});
	};
	// `a.input + a.output` in a declaration, return or argument is a total the surface made up, wherever it lands, even
	// when the sum is then concatenated into text; an addition with a string operand is text building, never a sum
	// (#434).
	const text = (node: ts.Expression): boolean => {
		const operand = unwrap(node);
		return (
			ts.isStringLiteral(operand) ||
			ts.isNoSubstitutionTemplateLiteral(operand) ||
			ts.isTemplateExpression(operand) ||
			(ts.isBinaryExpression(operand) && operand.operatorToken.kind === ts.SyntaxKind.PlusToken && addsText(operand))
		);
	};
	const addsText = (sum: ts.BinaryExpression): boolean => text(sum.left) || text(sum.right);
	const sumsTotals = (node: ts.BinaryExpression): boolean =>
		node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
		!text(node.left) &&
		!text(node.right) &&
		readsTotal(node.left) &&
		readsTotal(node.right);
	const visit = (node: ts.Node): void => {
		if (ts.isBinaryExpression(node)) {
			const kind = node.operatorToken.kind;
			if (sumsTotals(node)) report(node);
			if (kind === ts.SyntaxKind.PlusToken) {
				const left = unwrap(node.left);
				const right = unwrap(node.right);
				if (
					(ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) &&
					(ts.isPropertyAccessExpression(right) || ts.isElementAccessExpression(right)) &&
					new Set([field(left), field(right)]).size === 2 &&
					[field(left), field(right)].every((name) => name === "measured" || name === "estimated") &&
					left.expression.getText(tree) === right.expression.getText(tree) &&
					field(left.expression) !== "coverage"
				)
					report(node);
			}
			if (kind === ts.SyntaxKind.PlusEqualsToken && (total(node.left) || readsTotal(node.right))) report(node);
			const target = node.left.getText(tree);
			if (
				kind === ts.SyntaxKind.EqualsToken &&
				(total(node.left) || mergesComputedKey(node.left, node.right)) &&
				adds(node.right, (operand) => unwrap(operand).getText(tree) === target)
			)
				report(node);
		}
		if (ts.isPropertyAssignment(node)) {
			const name = node.name.getText(tree).replace(/["']/g, "");
			if (
				(TOTAL_NAME.test(name) || USAGE_FIELD.test(name)) &&
				adds(node.initializer, (operand) => field(unwrap(operand)) === name)
			)
				report(node);
		}
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === "reduce" &&
			(node.arguments.some((argument) => readsTotal(argument)) || readsTotal(node.expression.expression))
		)
			report(node);
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return [...new Set(violations)];
}

/**
 * Feature internals the composition root reached into before the 0.7.0
 * refactor moved memory routing, compaction and the session recorders into
 * their domains. The orchestrator wires the domain modules that own them; a
 * value import of one of these means feature logic is growing back.
 */
const COMPOSITION_ROOT_FORBIDDEN_MODULES: ReadonlyArray<string> = [
	"src/domains/session/compaction/compact.ts",
	"src/domains/session/compaction/branch-summary.ts",
	"src/domains/session/continuity/projection.ts",
	"src/domains/session/continuity/carry.ts",
	"src/domains/memory/background-budget.ts",
	"src/domains/memory/task-memory-policy.ts",
	"src/domains/memory/observations.ts",
	"src/domains/telemetry/call-scope.ts",
	"src/domains/telemetry/call-facts.ts",
	"src/domains/quota/observed.ts",
	"src/domains/store/workspace-signal.ts",
	"src/engine/ai.ts",
];

/** The same internals by name, since a barrel can re-export them. */
const COMPOSITION_ROOT_FORBIDDEN_NAMES: ReadonlySet<string> = new Set([
	"compact",
	"workspaceCapabilitySignals",
	"openCallScope",
	"completeEngineText",
	"streamSimple",
	"decideBackgroundStep",
	"resolveContinuityProjection",
	"continuityPayloadFromFold",
	"serializeConversation",
	"callSettlementFromMessage",
	"observedQuota",
	"entriesBeforeMemoryOff",
	"completedLessonSource",
	"observationCheckpoint",
	"observationSourceUnits",
	"buildDispatchMemorySection",
	"resolveEffectivePricing",
	"supportsAgentRoleTools",
	"resolveModelCapabilities",
	"protectedArtifactEntryFromArtifact",
	"stagePendingProtectedArtifact",
	"createRereadRecallPort",
	"isSkillActivation",
]);

/**
 * Module-scope functions the composition root keeps: boot itself, its
 * entry-only presentation, and thin bindings of a session-control or engine
 * value into a domain port. Anything else belongs to the domain that owns it.
 */
const COMPOSITION_ROOT_FUNCTIONS: ReadonlySet<string> = new Set([
	"bootOrchestrator",
	"bannerConfigurationLine",
	"buildBanner",
	"printJsonSessionHeader",
	"applyHeadlessSettingsOverlay",
	"createSystemOneOneShot",
	"createProductionAutoCompact",
	"replayCompactionHistory",
	"readSessionEntriesForCompact",
	"readFlowSessionEntries",
	"readRecentSessionEntriesForContract",
	"bindAcpHandoff",
]);

/** The composition root's size after the 0.7.0 refactor, with room for wiring only; the license header does not count. */
export const COMPOSITION_ROOT_LINE_CEILING = 4800;

/**
 * rule15: the composition root constructs and wires services. It does not
 * value-import feature internals, grow module-scope helpers, or grow past its
 * line ceiling.
 */
export function checkCompositionRoot(file: string, source: string): string[] {
	const violations: string[] = [];
	const tree = parseTree(file, source);
	const lineOf = (node: ts.Node): number => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	for (const statement of tree.statements) {
		if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
			const clause = statement.importClause;
			if (!clause || clause.isTypeOnly) continue;
			const named = clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings : undefined;
			const valueNames = (named?.elements ?? [])
				.filter((element) => !element.isTypeOnly)
				.map((element) => (element.propertyName ?? element.name).text);
			const hasValue =
				clause.name !== undefined ||
				(clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) ||
				valueNames.length > 0;
			if (!hasValue) continue;
			const specifier = statement.moduleSpecifier.text;
			if (specifier.startsWith(".")) {
				const resolved = path.posix
					.normalize(path.posix.join(path.posix.dirname(file), specifier))
					.replace(jsSuffixRegex, ".ts");
				if (COMPOSITION_ROOT_FORBIDDEN_MODULES.includes(resolved))
					violations.push(
						`rule15: ${file}:${lineOf(statement)} value-imports ${resolved}, a feature internal; wire the domain module that owns it instead`,
					);
			}
			for (const name of valueNames)
				if (COMPOSITION_ROOT_FORBIDDEN_NAMES.has(name))
					violations.push(
						`rule15: ${file}:${lineOf(statement)} value-imports ${name}, a feature internal; wire the domain module that owns it instead`,
					);
			continue;
		}
		const functions: Array<{ name: string; node: ts.Node }> = [];
		if (ts.isFunctionDeclaration(statement) && statement.name)
			functions.push({ name: statement.name.text, node: statement });
		if (ts.isVariableStatement(statement))
			for (const declaration of statement.declarationList.declarations)
				if (
					ts.isIdentifier(declaration.name) &&
					declaration.initializer &&
					(ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
				)
					functions.push({ name: declaration.name.text, node: declaration });
		for (const { name, node } of functions)
			if (!COMPOSITION_ROOT_FUNCTIONS.has(name))
				violations.push(
					`rule15: ${file}:${lineOf(node)} declares module-scope function ${name}; move feature logic to the domain that owns it, or list a wiring helper in COMPOSITION_ROOT_FUNCTIONS (tests/boundaries/check-boundaries.ts) with its reason`,
				);
	}
	const lines = stripLicenseHeader(source).split("\n").length;
	if (lines > COMPOSITION_ROOT_LINE_CEILING)
		violations.push(
			`rule15: ${file} has ${lines} lines, over the composition root's ceiling of ${COMPOSITION_ROOT_LINE_CEILING}; move feature logic to the domain that owns it rather than raising the ceiling`,
		);
	return violations;
}

/**
 * rule23: the most lines one function may span, from the line of its first token to the line of its last. Every
 * function form counts (declarations, expressions, arrows, methods, constructors, accessors), and a nested function
 * counts on its own as well as inside its parent.
 */
const FUNCTION_LINE_CEILING = 500;

/**
 * The functions over FUNCTION_LINE_CEILING when rule23 landed, each at the size it may not grow past. An entry only
 * shrinks: lower its number when its function shrinks, and remove it once the function is at or under the ceiling.
 * The key is `file#name`, the name qualified by its enclosing classes and functions. An anonymous function is named
 * by where it sits: `<iife>`, `<withLock callback>` for an argument to `withLock(...)`, else `<anonymous>`; a name
 * repeated in one file takes `[2]`, `[3]` in source order.
 */
const FUNCTION_LINE_EXEMPTIONS: ReadonlyMap<string, number> = new Map([
	["src/cli/modes/print.ts#runHeadlessMainAgent", 856],
	["src/cli/uninstall.ts#runUninstallCommand", 543],
	["src/cli/upgrade.ts#runUpgradeCommand", 568],
	["src/core/settings-validate.ts#validateSettings", 1270],
	["src/domains/dispatch/admission.ts#createCapacityAdmissionController", 547],
	["src/domains/dispatch/execution-scheduler.ts#executePlan", 662],
	["src/domains/dispatch/fleet-run.ts#runFleetHoldingWorkspace", 1043],
	["src/domains/dispatch/worker-spawn.ts#attachWorkerChannel", 740],
	["src/domains/gateway/mcp/http-transport.ts#createMcpHttpTransport", 642],
	["src/domains/memory/intervention.ts#createMemoryInterventionRegistration", 2148],
	["src/domains/mux/contract.ts#createMuxRuntime", 734],
	["src/domains/mux/socket-client.ts#createMuxClient", 553],
	["src/domains/providers/extension.ts#createProvidersBundle", 625],
	["src/domains/resources/hub-validation.ts#validateHubPackage", 567],
	["src/domains/safety/policy-engine.ts#createSafetyPolicyEngine", 1709],
	["src/domains/scheduling/job-controller.ts#createJobController", 979],
	["src/domains/session/compaction/compact.ts#compactWithCalls", 738],
	["src/domains/session/extension.ts#createSessionBundle", 505],
	["src/domains/telemetry/call-journal.ts#openCallJournal", 554],
	["src/domains/telemetry/call-journal.ts#openCallJournal.<withStateFileLock callback>", 513],
	["src/domains/telemetry/telemetry-live.ts#createLiveTelemetryModel", 607],
	["src/domains/workspace-snapshots/store.ts#createWorkspaceSnapshots", 628],
	["src/engine/acp/adapter.ts#startAcpDelegationRun", 721],
	["src/engine/acp/server.ts#servePancodeAcpAgent", 3780],
	["src/engine/loop-guard.ts#createLoopGuardRegistration", 1490],
	["src/engine/worker-runtime.ts#startWorkerRun", 2346],
	["src/entry/orchestrator.ts#bootOrchestrator", 3676],
	["src/interactive/chat-panel.ts#createChatPanel", 2064],
	["src/interactive/chat-panel.ts#createChatPanel.applyEvent", 534],
	["src/interactive/editor-submit.ts#createEditorSubmitController", 668],
	["src/interactive/interactive-application.ts#createInteractiveApplication", 2195],
	["src/interactive/interactive-presentation.ts#createInteractivePresentation", 1072],
	["src/interactive/interactive-slash-runtime.ts#createInteractiveSlashRuntime", 794],
	["src/interactive/overlay-general-openers.ts#createOverlayGeneralOpeners", 741],
	["src/interactive/overlay-lifecycle.ts#createOverlayLifecycle", 607],
	["src/interactive/overlay-permission-lifecycle.ts#createOverlayPermissionLifecycle", 671],
	["src/interactive/overlays/hub.ts#openHubOverlay", 604],
	["src/interactive/overlays/settings-items.ts#buildSettingItems", 523],
	["src/interactive/panes-runtime.ts#createPanesRuntime", 582],
	["src/session-control/chat-loop-composition.ts#createChatLoopComposition", 662],
	["src/session-control/chat-loop-state-machine.ts#createChatLoopStateMachine", 645],
	["src/session-control/chat-loop-submit.ts#createChatLoopSubmit", 1483],
	["src/session-control/chat-loop-submit.ts#createChatLoopSubmit.submit", 1439],
	["src/session-control/chat-loop.ts#createChatLoop", 1570],
	["src/session-control/turn-context-compaction.ts#createTurnContextCompaction", 1033],
	["src/session-control/turn-context-compaction.ts#createTurnContextCompaction.performAutoCompact", 737],
	["src/session-control/turn-context-prompt.ts#createTurnContextPrompt", 588],
	["src/session-control/turn-context.ts#createTurnContext", 2789],
	["src/session-control/turn-middleware.ts#createTurnMiddleware", 823],
	["src/session-control/turn-recovery.ts#createTurnRecovery", 681],
	["src/session-control/turn-runtime.ts#createTurnRuntime", 2222],
	["src/session-control/turn-runtime.ts#createTurnRuntime.ensureRuntime", 1812],
	["src/session-control/turn-runtime.ts#createTurnRuntime.ensureRuntime.onAgentEvent", 530],
	["src/tools/dispatch-admission.ts#createDispatchAdmissionController", 880],
	["src/tools/dispatch-compete.ts#runCompete", 543],
	["src/tools/dispatch-runner.ts#runDispatchTool", 550],
	["src/tools/gateway/index.ts#createGatewayTool", 875],
	["src/tools/gateway/mcp-capabilities.ts#createMcpCapabilitySource", 1680],
	["src/tools/registry.ts#createRegistry", 2340],
]);

function memberNameText(name: ts.PropertyName | ts.BindingName, tree: ts.SourceFile): string {
	return ts.isIdentifier(name) ||
		ts.isPrivateIdentifier(name) ||
		ts.isStringLiteral(name) ||
		ts.isNumericLiteral(name) ||
		ts.isNoSubstitutionTemplateLiteral(name)
		? name.text
		: name.getText(tree);
}

function functionNameSegment(node: ts.FunctionLikeDeclaration | ts.ClassLikeDeclaration, tree: ts.SourceFile): string {
	if (node.name) return memberNameText(node.name, tree);
	if (ts.isConstructorDeclaration(node)) return "constructor";
	const parent = node.parent;
	if (
		(ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) &&
		parent.initializer === node
	)
		return memberNameText(parent.name, tree);
	if (ts.isClassLike(node)) return "<class>";
	if (ts.isParenthesizedExpression(parent) && ts.isCallExpression(parent.parent) && parent.parent.expression === parent)
		return "<iife>";
	if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.includes(node as ts.Expression)) {
		const callee = parent.expression;
		const calleeName = ts.isIdentifier(callee)
			? callee.text
			: ts.isPropertyAccessExpression(callee)
				? callee.name.text
				: undefined;
		return calleeName ? `<${calleeName} callback>` : "<callback>";
	}
	return "<anonymous>";
}

/**
 * rule23 for one file: a function over FUNCTION_LINE_CEILING needs a FUNCTION_LINE_EXEMPTIONS entry, may not grow
 * past it, and an entry its function has shrunk below is stale. `seen` collects the exempt keys found, so the caller
 * can report entries whose function is gone.
 */
function checkFunctionLengths(file: string, source: string, seen: Set<string>): string[] {
	if (/\.d\.[cm]?ts$/.test(file)) return [];
	const violations: string[] = [];
	const tree = parseTree(file, source);
	const lineOf = (position: number): number => tree.getLineAndCharacterOfPosition(position).line + 1;
	const occurrences = new Map<string, number>();
	const visit = (node: ts.Node, scope: string): void => {
		let inner = scope;
		const isFunction =
			(ts.isFunctionDeclaration(node) ||
				ts.isFunctionExpression(node) ||
				ts.isArrowFunction(node) ||
				ts.isMethodDeclaration(node) ||
				ts.isConstructorDeclaration(node) ||
				ts.isGetAccessorDeclaration(node) ||
				ts.isSetAccessorDeclaration(node)) &&
			node.body !== undefined;
		if (isFunction || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
			let name = `${scope}${scope ? "." : ""}${functionNameSegment(node, tree)}`;
			const occurrence = (occurrences.get(name) ?? 0) + 1;
			occurrences.set(name, occurrence);
			if (occurrence > 1) name = `${name}[${occurrence}]`;
			inner = name;
		}
		if (isFunction) {
			const start = lineOf(node.getStart(tree));
			const lines = lineOf(node.end) - start + 1;
			const key = `${file}#${inner}`;
			const allowed = FUNCTION_LINE_EXEMPTIONS.get(key);
			if (allowed !== undefined) seen.add(key);
			if (allowed === undefined) {
				if (lines > FUNCTION_LINE_CEILING)
					violations.push(
						`rule23: ${file}:${start} ${inner} is ${lines} lines, over the ${FUNCTION_LINE_CEILING}-line function ceiling; split it into functions that each do one job. If an exempt function only moved or was renamed, rekey its old FUNCTION_LINE_EXEMPTIONS entry (tests/boundaries/check-boundaries.ts) to ${key} at the same number`,
					);
			} else if (lines <= FUNCTION_LINE_CEILING) {
				violations.push(
					`rule23: FUNCTION_LINE_EXEMPTIONS lists ${key}, which is now ${lines} lines, within the ${FUNCTION_LINE_CEILING}-line ceiling; remove the entry`,
				);
			} else if (lines > allowed) {
				violations.push(
					`rule23: ${file}:${start} ${inner} grew to ${lines} lines, past the ${allowed} its FUNCTION_LINE_EXEMPTIONS entry allows; an exempt function may only shrink, so move the new logic out of it`,
				);
			} else if (lines < allowed) {
				violations.push(
					`rule23: FUNCTION_LINE_EXEMPTIONS allows ${key} ${allowed} lines and it is now ${lines}; lower the entry to ${lines}`,
				);
			}
		}
		ts.forEachChild(node, (child) => visit(child, inner));
	};
	visit(tree, "");
	return violations;
}

const jsSuffixRegex = /\.m?jsx?$/;
const piPackagePrefix = "@earendil-works/pi-";
// Since the 0.83.0 engine-boundary rework, no file outside src/engine/** may
// import @earendil-works/* at all, type-only included. Domains take erased
// engine shapes (EngineModel, Api, Model) from src/engine/types.ts.
const allowedPiTypeImportSpecifiersOutsideEngine = new Set<string>();

function walk(dir: string): string[] {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...walk(full));
			continue;
		}
		if (entry.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx") || full.endsWith(".mts"))) {
			files.push(full);
		}
	}
	return files;
}

function isWithin(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function stripComments(source: string): string {
	let out = source.replace(/\/\*[\s\S]*?\*\//g, "");
	out = out.replace(/(^|[^:/])\/\/.*$/gm, (_match, prefix) => prefix);
	return out;
}

function extractReferenceDirectives(source: string): { kind: "path" | "types"; specifier: string }[] {
	const directives: { kind: "path" | "types"; specifier: string }[] = [];
	const regex = /^\s*\/\/\/\s*<reference\s+(path|types)\s*=\s*["']([^"']+)["']\s*\/?>/gm;
	for (const match of source.matchAll(regex)) {
		const kind = match[1] as "path" | "types";
		const specifier = match[2];
		if (specifier) directives.push({ kind, specifier });
	}
	return directives;
}

interface ExtractedSpecifier {
	specifier: string;
	typeOnly: boolean;
	dynamic: boolean;
}

function isTypeOnlyImportOrExportClause(clause: string): boolean {
	return clause.trim().startsWith("type ");
}

function extractSpecifiers(source: string): ExtractedSpecifier[] {
	const stripped = stripComments(source);
	const specifiers: ExtractedSpecifier[] = [];

	const fromRegex = /\b(import|export)\b([\s\S]*?)\bfrom\s*["']([^"']+)["']/g;
	for (const match of stripped.matchAll(fromRegex)) {
		const clause = match[2] ?? "";
		const specifier = match[3];
		if (!specifier) continue;
		const typeOnly = isTypeOnlyImportOrExportClause(clause);
		specifiers.push({ specifier, typeOnly, dynamic: false });
	}

	const sideEffectRegex = /(?:^|[;\n])\s*import\s*["']([^"']+)["']/g;
	for (const match of stripped.matchAll(sideEffectRegex)) {
		const specifier = match[1];
		if (specifier) specifiers.push({ specifier, typeOnly: false, dynamic: false });
	}

	const dynRegex = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
	for (const match of stripped.matchAll(dynRegex)) {
		const specifier = match[1];
		if (specifier) specifiers.push({ specifier, typeOnly: false, dynamic: true });
	}

	return specifiers;
}

const resolvedImports = new Map<string, string>();
function resolveRelativeImport(fromFile: string, specifier: string): string {
	const candidate = path.resolve(path.dirname(fromFile), specifier);
	const known = resolvedImports.get(candidate);
	if (known !== undefined) return known;
	const resolved = resolveCandidate(candidate);
	resolvedImports.set(candidate, resolved);
	return resolved;
}

function resolveCandidate(candidate: string): string {
	const tsRewrites: string[] = [];
	if (jsSuffixRegex.test(candidate)) {
		const stripped = candidate.replace(jsSuffixRegex, "");
		tsRewrites.push(`${stripped}.ts`, `${stripped}.tsx`, `${stripped}.mts`);
	}
	const candidates = [
		candidate,
		`${candidate}.ts`,
		`${candidate}.tsx`,
		`${candidate}.mts`,
		path.join(candidate, "index.ts"),
		path.join(candidate, "index.tsx"),
		path.join(candidate, "index.mts"),
		...tsRewrites,
	];
	for (const item of candidates) {
		try {
			if (statSync(item, { throwIfNoEntry: false })?.isFile()) return item;
		} catch {
			// skip
		}
	}
	return candidate;
}

/**
 * The chat loop's turn state machine and its single-owner turn modules in
 * src/session-control. The interactive composition root in index.ts
 * legitimately knows about entry-level wiring; these do not.
 */
function isChatLoopTurnModule(filePath: string): boolean {
	const base = path.basename(filePath);
	return (base.startsWith("chat-loop") || base.startsWith("turn-")) && base.endsWith(".ts");
}

/**
 * The instant shell's Stage 0 owner. `tests/contracts/instant-shell-import-graph.test.ts`
 * walks the built chunk that contains this module and holds its static closure
 * to 32 chunks, 1,400,000 total bytes and 400,000 PanCode source bytes, because that closure is what a cold
 * `pancode` start pays before it can draw anything.
 */
const STAGE_0_OWNER = path.join("src", "interactive", "terminal-lease.ts");

/**
 * Modules an external runtime reacher may enter inside `src/interactive/**`,
 * `src/session-control/**` or `src/engine/**`. The session-control tree holds
 * the turn engine that used to live in `src/interactive/**`, so it keeps the
 * same protection: its chunk membership is part of what Stage 0 is measured on.
 *
 * The first two Stage 0 splits came from `src/cli/**`; the third came from
 * `src/domains/mux/**`. Esbuild responds to both identically: when a module in
 * the instant shell's closure gains a second, disjoint reacher, it peels that
 * module out of the neighbours it used to share a chunk with. Rule 6 therefore
 * guards every value importer outside the computed Stage 0 closure and the two
 * protected trees, not one directory that happened to contain earlier bugs.
 *
 * Every existing edge is declared here with its architectural reason. A seam
 * still fails the closure walk unless it stays off Stage 0. The only explicit
 * overlap exceptions are the Stage 1 composition-root edges that assemble the
 * complete interactive application and already own those dependencies.
 */
interface Stage0Seam {
	/** Project-relative module path, POSIX-separated. */
	module: string;
	/** Why an external runtime reacher legitimately enters through this module. */
	reason: string;
	/** Existing composition roots allowed to overlap Stage 0 through this seam. */
	allowStage0OverlapFrom?: readonly string[];
}

const ORCHESTRATOR = "src/entry/orchestrator.ts";

const STAGE0_SEAMS: ReadonlyArray<Stage0Seam> = [
	{
		module: "src/session-control/index.ts",
		reason:
			"the composition root and transports share permission, restore and model decisions through one render-free in-process contract.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
	},
	{
		module: "src/session-control/turn-outcome-collector.ts",
		reason:
			"the composition root registers a surface-neutral observer whose value closure contains only core, pure turn-control, and tool-call shapes, never terminal rendering.",
	},
	{
		module: "src/interactive/terminal-lease.ts",
		reason:
			"the Stage 0 owner itself. src/cli/pancode.ts is the surface that opens the instant shell, so this edge is the budget rather than a leak, and the closure guard below skips it.",
	},
	{
		module: "src/session-control/slash-commands.ts",
		reason:
			"one slash parser and one registry-membership source for both surfaces. The headless refusal in src/cli/run.ts and the TUI editor must agree on which tokens name a command, and a second copy of the parser would drift. The registry's own imports are what the closure guard below watches.",
	},
	{
		module: "src/session-control/reload-report.ts",
		reason:
			"the reload target and report types the headless steer channel hands to the reload service. A type-only leaf: no importer reaches a value through it.",
	},
	{
		module: "src/session-control/session-notices.ts",
		reason:
			"one projection of the session facts every surface reports. The headless stderr sink in src/cli/headless-notices.ts reads the same facts the terminal and ACP render; its value closure is formatter text over core shapes.",
	},
	{
		module: "src/session-control/chat-loop.ts",
		reason: "the Stage 1 composition root creates the chat loop; CLI event-shape imports are type-only and erase.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
	},
	{
		module: "src/session-control/chat-loop-messages.ts",
		reason:
			"sumRunUsage, the one usage fold both the CLI modes and the TUI report from. Its value closure stays on domains and engine/ai, off the render graph.",
	},
	{
		module: "src/session-control/side-question.ts",
		reason:
			"runOutOfTurnRound, the one round a subscription route can answer through, since such a target has no chat wire. `systemone check --live` must ask the way a session's engine asks, or it would verify a path no session uses. Reached only by dynamic import behind that subcommand, so the CLI skips the chat loop that re-exports it, and its closure stays on domains, core and the provider half of the engine, off the Stage 0 closure.",
	},
	{
		module: "src/session-control/attempt-receipt.ts",
		reason:
			"verifyAttemptReceipts, the one verifier `context working-set --verify` runs, since it must render and finalize a request the way the send path does or it would verify a request no session sent. Reached only by dynamic import behind that flag, and its closure stays on the replay renderer, request-structure digests and the engine's provider history, off the Stage 0 closure.",
	},
	{
		module: "src/engine/tui-primitives.ts",
		reason:
			"a pure re-export of the three pi-tui symbols src/cli/fleet-view.ts needs. It has no relative imports at all, and boundaries rule1 forbids the CLI importing pi-tui directly, so this module is why fleet-view does not touch the engine tui barrel.",
	},
	{
		module: "src/engine/clipboard.ts",
		reason:
			"the confirmed system clipboard copy (#437) the fullscreen CLI views (fleet view, workers board, extension dock) hand pi-tui as copySelection, so they never flash Copied! for a bare OSC 52. Reached only by dynamic import on the first copy. It has no relative imports at all: its static imports are node built-ins, and pi-tui's native clipboard loads lazily on darwin and win32.",
	},
	{
		module: "src/engine/types.ts",
		reason:
			"the erased engine shapes (AgentMessage, ImageContent) domains and the CLI both take. Type-only at every call site.",
	},
	{
		module: "src/engine/oauth.ts",
		reason:
			"OAuth provider registration for `auth`/`configure` and the prompt shape `oauth-select` renders. Reaches only alcf-oauth, none of it terminal rendering.",
	},
	{
		module: "src/engine/session.ts",
		reason:
			"the canonical session path, atomic-write, and JSONL persistence substrate shared by lifecycle, dispatch, session domains, the CLI, and the Stage 1 composition root; its closure stays off terminal rendering.",
	},
	{
		module: "src/engine/pi-mono-names.ts",
		reason: "the dependency-name table package-root and lifecycle version reporting inspect; a constant-only leaf.",
	},
	{
		module: "src/engine/truncate.ts",
		reason: "surface-neutral byte and display truncation shared by context markers and tools.",
	},
	{
		module: "src/engine/acp/adapter.ts",
		reason: "dispatch translates worker results through the engine-owned ACP protocol adapter.",
	},
	{
		module: "src/engine/acp/server.ts",
		reason: "the Stage 1 composition root owns the ACP server surface.",
	},
	{
		module: "src/engine/acp/server-handshake.ts",
		reason:
			"the ACP CLI answers `initialize` before the orchestrator boots, so it negotiates the handshake through this module, which the ACP server seam already reached.",
	},
	{
		module: "src/engine/acp/deferred-boot.ts",
		reason:
			"the ACP CLI keeps its transport open while the first workspace request selects a root; deferred boot depends only on ACP protocol leaves.",
	},
	{
		module: "src/engine/acp/commands.ts",
		reason:
			"the Stage 1 composition root binds the operator-command control the ACP server takes by structure. The projection value-imports the slash registry, which the root already reaches directly, so it enters the Stage 0 overlap through the same door it already owns rather than through the ACP server seam.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
	},
	{
		module: "src/engine/acp/host-members.ts",
		reason:
			"the ACP host's members for /share, /oracle and /council: the worker-run fold and the oracle briefing the terminal also uses, and the host-made dispatch call. Only the Stage 1 composition root reaches it, the same root that already overlaps Stage 0 through the chat loop.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
	},
	{
		module: "src/engine/acp/transport.ts",
		reason: "the Stage 1 composition root owns ACP stdio transport construction.",
	},
	{
		module: "src/engine/antigravity/subprocess-runtime.ts",
		reason: "dispatch maps autonomy policy into the engine-owned Antigravity subprocess runtime.",
	},
	{
		module: "src/engine/claude/subprocess-runtime.ts",
		reason: "dispatch maps autonomy policy into the engine-owned Claude subprocess runtime.",
	},
	{
		module: "src/engine/claude/tool-safety.ts",
		reason: "dispatch classifies Claude's canonical tool names through the engine adapter that owns them.",
	},
	{
		module: "src/engine/worker-runtime-capabilities.ts",
		reason: "dispatch reads the engine worker's static mediation capability contract.",
	},
	{
		module: "src/engine/env-api-keys.ts",
		reason: "provider authentication uses the engine's environment-key lookup ladder.",
	},
	{
		module: "src/engine/ai.ts",
		reason:
			"provider, session, and tool surfaces use the engine-owned model bridge and error classifiers; its closure is deliberately terminal-free.",
	},
	{
		module: "src/engine/apis/index.ts",
		reason: "the provider extension registers engine API implementations at the domain composition boundary.",
	},
	{
		module: "src/engine/api-registry.ts",
		reason: "the provider plugin loader activates the engine-owned external API bridge.",
	},
	{
		module: "src/engine/prompt-templates.ts",
		reason: "resource loaders share the engine's argument parser and substitution semantics.",
	},
	{
		module: "src/engine/strip-tokenizer-sentinels.ts",
		reason: "session previews reuse the engine's pure tokenizer-sentinel normalizer.",
	},
	{
		module: "src/engine/apis/residency.ts",
		reason: "the orchestrator and worker entry points share engine model-residency policy.",
	},
	{
		module: "src/engine/loop-guard.ts",
		reason: "the Stage 1 composition root wires the engine-owned loop guard.",
	},
	{
		module: "src/engine/worker-runtime.ts",
		reason: "the worker entry point boots the engine-owned worker runtime.",
	},
	{
		module: "src/engine/worker-tools.ts",
		reason: "the worker entry point installs the engine-owned worker tool bridge.",
	},
	{
		module: "src/interactive/index.ts",
		reason: "the Stage 1 composition root assembles the complete interactive application.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
	},
	{
		module: "src/interactive/keybinding-manager.ts",
		reason: "the Stage 1 composition root supplies the keybinding manager to the application it assembles.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
	},
	{
		module: "src/session-control/loop-guard-interrupt.ts",
		reason: "the Stage 1 composition root connects engine loop-guard stops to interactive cancellation.",
	},
	{
		module: "src/session-control/model-session-replay.ts",
		reason: "the Stage 1 composition root projects persisted turns back into interactive model messages.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
	},
	{
		module: "src/interactive/panes-runtime.ts",
		reason: "the panes composition root (src/entry/with-panes.ts) creates the optional interactive panes runtime.",
	},
	{
		module: "src/interactive/mux-bridge.ts",
		reason:
			"the panes composition root (src/entry/with-panes.ts) supplies the dispatch-to-pane bridge factory; it loads only behind the --with-panes dynamic import.",
	},
	{
		module: "src/interactive/yazi-bridge.ts",
		reason:
			"the panes composition root (src/entry/with-panes.ts) supplies the file-pane bridge factory; it loads only behind the --with-panes dynamic import.",
	},
	{
		module: "src/interactive/watch-pane.ts",
		reason:
			"the panes composition root (src/entry/with-panes.ts) supplies the workers-view watch-pane factory; it loads only behind the --with-panes dynamic import.",
	},
	{
		module: "src/interactive/tool-prose-registration.ts",
		reason: "the Stage 1 composition root registers interactive prose renderers for tool results.",
	},
	{
		module: "src/session-control/watchdog-run.ts",
		reason: "the Stage 1 composition root wires watchdog review into the complete interactive application.",
		allowStage0OverlapFrom: [ORCHESTRATOR],
	},
];

const STAGE0_SEAMS_BY_MODULE = new Map(STAGE0_SEAMS.map((seam) => [seam.module, seam]));

/**
 * The value-import closure of `entry`. Type-only imports are skipped because
 * they erase before the bundler sees them; dynamic imports are followed because
 * they are exactly what splits a chunk.
 */
function valueImportClosure(entry: string): Set<string> {
	const seen = new Set<string>();
	const stack = [entry];
	while (stack.length > 0) {
		const file = stack.pop();
		if (file === undefined || seen.has(file)) continue;
		let source: string;
		try {
			source = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		seen.add(file);
		for (const { specifier, typeOnly } of extractSpecifiers(source)) {
			if (typeOnly) continue;
			if (!(specifier.startsWith(".") || specifier.startsWith("/"))) continue;
			const resolved = resolveRelativeImport(file, specifier);
			if (!seen.has(resolved)) stack.push(resolved);
		}
	}
	return seen;
}

/**
 * The static value-import closure of `entry`, each file mapped to the file
 * that first imported it (the entry maps to null). Type-only imports erase and
 * dynamic imports split a chunk, so neither is followed: this is what the
 * entry's chunk loads before its first line runs.
 */
function staticValueImportClosure(entry: string): Map<string, string | null> {
	const parents = new Map<string, string | null>([[entry, null]]);
	const queue = [entry];
	for (let index = 0; index < queue.length; index++) {
		const file = queue[index] as string;
		let source: string;
		try {
			source = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const { specifier, typeOnly, dynamic } of extractSpecifiers(source)) {
			if (typeOnly || dynamic) continue;
			if (!(specifier.startsWith(".") || specifier.startsWith("/"))) continue;
			const resolved = resolveRelativeImport(file, specifier);
			if (parents.has(resolved)) continue;
			parents.set(resolved, file);
			queue.push(resolved);
		}
	}
	return parents;
}

/**
 * Orchestrator-only modules the worker must not load statically (rule 2b):
 * every domain bundle (`extension.ts`), the heavy modules only the
 * orchestrator's composition reaches, and the MCP client, hub and plugin
 * code a worker loads only when it admits an MCP server.
 */
function isWorkerDeniedModule(relative: string): boolean {
	return (
		/^src\/domains\/[^/]+\/extension\.ts$/u.test(relative) ||
		relative === "src/domains/telemetry/read-model.ts" ||
		relative === "src/domains/memory/intervention.ts" ||
		relative.startsWith("src/domains/context/wiki/") ||
		relative.startsWith("src/domains/gateway/") ||
		relative.startsWith("src/domains/resources/") ||
		relative.startsWith("src/domains/plugins/") ||
		relative === "src/core/settings-controls.ts"
	);
}

function checkWorkerClosure(projectRoot: string): string[] {
	const entry = path.join(projectRoot, "src", "worker", "entry.ts");
	const parents = staticValueImportClosure(entry);
	const relative = (file: string): string => path.relative(projectRoot, file).split(path.sep).join("/");
	const violations: string[] = [];
	for (const file of parents.keys()) {
		const rel = relative(file);
		if (!isWorkerDeniedModule(rel)) continue;
		const chain: string[] = [];
		for (let at: string | null | undefined = file; at; at = parents.get(at)) chain.unshift(relative(at));
		violations.push(
			`rule2b: the worker statically loads ${rel}, an orchestrator-only module (import it lazily or from a lighter module): ${chain.join(" -> ")}`,
		);
	}
	return violations;
}

function domainOf(filePath: string, domainsRoot: string): string | null {
	if (!isWithin(filePath, domainsRoot)) return null;
	const rel = path.relative(domainsRoot, filePath);
	const first = rel.split(path.sep)[0];
	return first ?? null;
}

function isAllowedWorkerProviderValueImport(resolved: string, providersDomainRoot: string): boolean {
	const allowedFiles = new Set([
		path.join(providersDomainRoot, "plugins.ts"),
		path.join(providersDomainRoot, "registry.ts"),
		path.join(providersDomainRoot, "runtimes", "builtins.ts"),
	]);
	return allowedFiles.has(resolved);
}

/**
 * The workspace packages each package under packages/ may import by name (rule21). No package imports
 * another today; a package not listed here imports none.
 */
const PACKAGE_IMPORTS: ReadonlyMap<string, ReadonlySet<string>> = new Map();
const WORKSPACE_PACKAGE = /^@pancode\/([^/]+)(?:\/|$)/;

/** Source files under `dir`, without installed dependencies or build output. */
function walkSources(dir: string): string[] {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : walkSources(full);
		return entry.isFile() && /\.(?:ts|tsx|mts)$/.test(entry.name) ? [full] : [];
	});
}

/**
 * Every import and reference specifier of `source`, type-only marked, with references made path-relative.
 * Bare side-effect imports (`import "x";`) count too: extractSpecifiers only sees `from` clauses and `import()`.
 */
function importsOf(source: string): ExtractedSpecifier[] {
	const sideEffects = [...stripComments(source).matchAll(/(?:^|[;}])\s*import\s*["']([^"']+)["']/gm)].map((match) => ({
		specifier: match[1] ?? "",
		typeOnly: false,
		dynamic: false,
	}));
	return [
		...extractSpecifiers(source),
		...sideEffects,
		...extractReferenceDirectives(source).map((ref) => ({
			specifier:
				ref.kind === "path" && !(ref.specifier.startsWith(".") || ref.specifier.startsWith("/"))
					? `./${ref.specifier}`
					: ref.specifier,
			typeOnly: true,
			dynamic: false,
		})),
	];
}

/**
 * Workspace package boundaries, type-only imports included in each:
 *  19. Files under packages/<name>/src never import root src/, apps/ or
 *      @earendil-works/pi-*: a package installs and runs without the harness.
 *  20. Files under root src/ and apps/ reach a package only through its
 *      package name, never through a relative path into packages/, so the
 *      bundle, tsx and the typecheck all see the one resolution tsconfig
 *      paths gives them.
 *  21. A package imports only the workspace packages PACKAGE_IMPORTS lists
 *      for it, and only by name.
 */
function checkPackageBoundaries(projectRoot: string): string[] {
	const srcRoot = path.join(projectRoot, "src");
	const appsRoot = path.join(projectRoot, "apps");
	const packagesRoot = path.join(projectRoot, "packages");
	const packageOf = (file: string): string | null =>
		isWithin(file, packagesRoot) ? (path.relative(packagesRoot, file).split(path.sep)[0] ?? null) : null;
	const display = (file: string): string => path.relative(projectRoot, file).split(path.sep).join("/");
	const violations: string[] = [];
	let packageNames: string[] = [];
	try {
		packageNames = readdirSync(packagesRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		// No packages/ directory: nothing to check.
	}
	for (const name of packageNames) {
		const allowed = PACKAGE_IMPORTS.get(name) ?? new Set<string>();
		for (const file of walkSources(path.join(packagesRoot, name, "src"))) {
			for (const { specifier, typeOnly } of importsOf(readFileSync(file, "utf8"))) {
				const qualifier = typeOnly ? " (type-only)" : "";
				if (specifier.startsWith(piPackagePrefix) || specifier === "pancode" || specifier.startsWith("pancode/")) {
					violations.push(
						`rule19: ${display(file)} imports${qualifier} ${specifier}; a workspace package never depends on the harness or the Pi SDK`,
					);
					continue;
				}
				const named = WORKSPACE_PACKAGE.exec(specifier)?.[1];
				if (named !== undefined) {
					if (!allowed.has(named))
						violations.push(
							`rule21: ${display(file)} imports${qualifier} ${specifier}; @pancode/${name} may import ${allowed.size > 0 ? [...allowed].map((dep) => `@pancode/${dep}`).join(", ") : "no workspace package"} (PACKAGE_IMPORTS)`,
						);
					continue;
				}
				if (!(specifier.startsWith(".") || specifier.startsWith("/"))) continue;
				const resolved = resolveRelativeImport(file, specifier);
				if (isWithin(resolved, srcRoot) || isWithin(resolved, appsRoot)) {
					violations.push(
						`rule19: ${display(file)} imports${qualifier} ${specifier} which resolves to ${display(resolved)}; a workspace package never depends on the harness`,
					);
				} else if (packageOf(resolved) !== null && packageOf(resolved) !== name) {
					violations.push(
						`rule21: ${display(file)} imports${qualifier} ${specifier} which resolves into packages/${packageOf(resolved)}; reach another package only by its name`,
					);
				}
			}
		}
	}
	for (const file of [...walkSources(srcRoot), ...walkSources(appsRoot)]) {
		for (const { specifier, typeOnly } of importsOf(readFileSync(file, "utf8"))) {
			if (!(specifier.startsWith(".") || specifier.startsWith("/"))) continue;
			const resolved = resolveRelativeImport(file, specifier);
			const target = packageOf(resolved);
			if (target === null) continue;
			violations.push(
				`rule20: ${display(file)} imports${typeOnly ? " (type-only)" : ""} ${specifier} which resolves into packages/${target}; import @pancode/${target} by name instead`,
			);
		}
	}
	return violations;
}

const TURN_STATE_OWNER = "src/session-control/turn-state.ts";
const TURN_STATE_COMPOSER = "src/session-control/chat-loop.ts";
/** `continuation` itself plus the flags it replaced, so a plain field cannot quietly come back. */
const CONTINUATION_FIELDS = new Set([
	"continuation",
	"pendingRequestContinuation",
	"pendingInRunContinuation",
	"stalledTurnNudgeSpent",
	"verificationNudgeSpent",
	"yoloContinuations",
	"turnStop",
]);

/**
 * Built-in recipe ids, read from the shipped recipe files: rule18 forbids branching on one outside the agents domain.
 */
const BUILTIN_RECIPE_IDS: ReadonlySet<string> = new Set(
	readdirSync(new URL("../../src/domains/agents/builtins/", import.meta.url))
		.filter((name) => name.endsWith(".md"))
		.map((name) => name.slice(0, -".md".length)),
);
const RECIPE_ID_OWNER = "src/domains/agents/";

/** An expression that holds a recipe id: `agentId`, `x.recipeId`, `baselineAgentId`, `spec.id`, `agent`. */
function holdsRecipeId(node: ts.Expression): boolean {
	while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node))
		node = node.expression;
	const named = (name: string): boolean => /(agentId|recipeId)$/iu.test(name) || name === "agent" || name === "recipe";
	if (ts.isIdentifier(node)) return named(node.text);
	if (!ts.isPropertyAccessExpression(node)) return false;
	if (named(node.name.text)) return true;
	if (node.name.text !== "id") return false;
	const owner = node.expression;
	const ownerName = ts.isIdentifier(owner) ? owner.text : ts.isPropertyAccessExpression(owner) ? owner.name.text : "";
	return /(spec|recipe|agent)$/iu.test(ownerName);
}

/**
 * Rule 18 (fleet M12): outside `src/domains/agents/` no code branches on a built-in recipe id. A comparison, a
 * `switch` case or a literal list membership test against one is a recipe-id branch; say what differs with the role,
 * the envelope, or a recipe frontmatter field (`category`, `product`, `traits`, `handbook`, the result contract).
 */
export function checkRecipeIdBranches(file: string, source: string): string[] {
	if (!file.startsWith("src/") || file.startsWith(RECIPE_ID_OWNER)) return [];
	const tree = parseTree(file, source);
	const violations: string[] = [];
	const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const recipeLiteral = (node: ts.Node): string | undefined =>
		ts.isStringLiteralLike(node) && BUILTIN_RECIPE_IDS.has(node.text) ? node.text : undefined;
	const report = (node: ts.Node, id: string): void => {
		violations.push(
			`rule18: ${file}:${line(node)} branches on recipe id "${id}"; outside ${RECIPE_ID_OWNER} decide by the role, the envelope, or a recipe frontmatter field`,
		);
	};
	const EQUALITY = new Set([
		ts.SyntaxKind.EqualsEqualsEqualsToken,
		ts.SyntaxKind.ExclamationEqualsEqualsToken,
		ts.SyntaxKind.EqualsEqualsToken,
		ts.SyntaxKind.ExclamationEqualsToken,
	]);
	const visit = (node: ts.Node): void => {
		if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
			const id = recipeLiteral(node.right) ?? recipeLiteral(node.left);
			const other = recipeLiteral(node.right) !== undefined ? node.left : node.right;
			if (id !== undefined && holdsRecipeId(other)) report(node, id);
		}
		if (ts.isSwitchStatement(node) && holdsRecipeId(node.expression)) {
			for (const clause of node.caseBlock.clauses) {
				const id = ts.isCaseClause(clause) ? recipeLiteral(clause.expression) : undefined;
				if (id !== undefined) report(clause, id);
			}
		}
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			(node.expression.name.text === "includes" || node.expression.name.text === "has") &&
			node.arguments[0] !== undefined &&
			holdsRecipeId(node.arguments[0])
		) {
			let list: ts.Expression = node.expression.expression;
			if (ts.isNewExpression(list) && list.arguments?.[0] !== undefined) list = list.arguments[0];
			const id = ts.isArrayLiteralExpression(list)
				? list.elements.map((element) => recipeLiteral(element)).find((entry) => entry !== undefined)
				: undefined;
			if (id !== undefined) report(node, id);
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return violations;
}

/** Rule 16: turn modules take their declared state view, and only ContinuationState writes continuation state. */
export function checkTurnStateOwnership(file: string, source: string): string[] {
	if (!file.startsWith("src/") || file === TURN_STATE_OWNER) return [];
	const inSessionControl = file.startsWith("src/session-control/");
	const tree = parseTree(file, source);
	const violations: string[] = [];
	const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const writtenField = (target: ts.Expression): string | undefined => {
		while (ts.isParenthesizedExpression(target) || ts.isNonNullExpression(target) || ts.isAsExpression(target))
			target = target.expression;
		const name = ts.isPropertyAccessExpression(target)
			? target.name.text
			: ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)
				? target.argumentExpression.text
				: undefined;
		return name !== undefined && CONTINUATION_FIELDS.has(name) ? name : undefined;
	};
	const visit = (node: ts.Node): void => {
		if (file !== TURN_STATE_COMPOSER && ts.isIdentifier(node) && node.text === "ChatTurnState") {
			violations.push(
				`rule16: ${file}:${line(node)} names the whole ChatTurnState; only ${TURN_STATE_COMPOSER} composes it, every other module takes the view ${TURN_STATE_OWNER} declares for it`,
			);
		}
		let field: string | undefined;
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
			node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
		)
			field = writtenField(node.left);
		else if (
			(ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
			(node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
		)
			field = writtenField(node.operand);
		if (inSessionControl && field !== undefined) {
			violations.push(
				`rule16: ${file}:${line(node)} writes ${field}; continuation state changes only through the ContinuationState methods in ${TURN_STATE_OWNER}`,
			);
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return violations;
}

const GIT_RUNNER = "src/core/internal-git-run.ts";
/** Calls outside {@link GIT_RUNNER} that start git, each kept with its reason (rule 24). */
const GIT_SPAWN_EXEMPTIONS: ReadonlyArray<{ file: string; callee: string; reason: string }> = [
	{
		file: "src/tools/safe-exec.ts",
		callee: "runVectorTool",
		reason:
			"the typed git tool is the agent's git, not PanCode's: it carries its own host config, and its add and commit run the repository's hooks on purpose",
	},
];
/** Helpers that take git as a display word, not a program: they start nothing. */
const GIT_WORD_CALLEES: ReadonlySet<string> = new Set(["joinDefined"]);
/** Runners whose executable argument sits after leading metadata (for example `runVectorTool(toolName, file, ...)`). */
const GIT_PROGRAM_ARG_INDEX: ReadonlyMap<string, number> = new Map([["runVectorTool", 1]]);
const CHILD_PROCESS_MODULES = new Set(["node:child_process", "child_process"]);
const UTIL_MODULES = new Set(["node:util", "util"]);
const INTERNAL_GIT_MODULE = /(?:^|\/)internal-git(?:\.[cm]?[jt]s)?$/u;

function unwrapExpression(node: ts.Expression): ts.Expression {
	while (
		ts.isParenthesizedExpression(node) ||
		ts.isAsExpression(node) ||
		ts.isSatisfiesExpression(node) ||
		ts.isNonNullExpression(node)
	)
		node = node.expression;
	return node;
}

function dynamicImportSpecifier(node: ts.Expression): string | undefined {
	let expr = unwrapExpression(node);
	if (ts.isAwaitExpression(expr)) expr = unwrapExpression(expr.expression);
	if (
		ts.isCallExpression(expr) &&
		expr.expression.kind === ts.SyntaxKind.ImportKeyword &&
		expr.arguments.length > 0 &&
		ts.isStringLiteralLike(expr.arguments[0] as ts.Expression)
	)
		return (expr.arguments[0] as ts.StringLiteralLike).text;
	return undefined;
}

function isGitCommandLiteral(node: ts.Expression): boolean {
	const expr = unwrapExpression(node);
	return (
		(ts.isStringLiteralLike(expr) || ts.isTemplateExpression(expr)) &&
		/^git\s/u.test(ts.isTemplateExpression(expr) ? expr.head.text : expr.text)
	);
}

/**
 * Rule 24: PanCode starts git only through {@link GIT_RUNNER}, which hardens every argv with internalGitArgv. Outside
 * it, no call in src/ passes git as the program: the literal `"git"` (or a const bound to it) at the program slot with
 * more arguments after, or a `git ...` command line to node:child_process (directly, aliased, promisified or via
 * dynamic import). Only the runner imports internalGitArgv.
 */
export function checkGitSpawns(file: string, source: string, usedExemptions?: Set<string>): string[] {
	if (!file.startsWith("src/") || file === GIT_RUNNER) return [];
	const tree = parseTree(file, source);
	const violations: string[] = [];
	const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
	const gitNames = new Set<string>();
	const gitCommandLines = new Set<string>();
	const childProcessNames = new Set<string>();
	const promisifyNames = new Set<string>();
	const utilNamespaces = new Set<string>();
	const internalGitNamespaces = new Set<string>();
	const reportInternalGitArgv = (node: ts.Node, verb: string): void => {
		violations.push(
			`rule24: ${file}:${line(node)} ${verb} internalGitArgv; start git through ${GIT_RUNNER}, which applies it`,
		);
	};
	for (const statement of tree.statements) {
		if (
			ts.isImportDeclaration(statement) &&
			ts.isStringLiteral(statement.moduleSpecifier) &&
			statement.importClause !== undefined &&
			!statement.importClause.isTypeOnly
		) {
			const spec = statement.moduleSpecifier.text;
			const bindings = statement.importClause.namedBindings;
			const named = bindings !== undefined && ts.isNamedImports(bindings) ? bindings.elements : [];
			if (CHILD_PROCESS_MODULES.has(spec)) {
				if (statement.importClause.name !== undefined) childProcessNames.add(statement.importClause.name.text);
				if (bindings !== undefined && ts.isNamespaceImport(bindings)) childProcessNames.add(bindings.name.text);
				for (const element of named) if (!element.isTypeOnly) childProcessNames.add(element.name.text);
			}
			if (UTIL_MODULES.has(spec)) {
				if (statement.importClause.name !== undefined) utilNamespaces.add(statement.importClause.name.text);
				if (bindings !== undefined && ts.isNamespaceImport(bindings)) utilNamespaces.add(bindings.name.text);
				for (const element of named)
					if (!element.isTypeOnly && (element.propertyName ?? element.name).text === "promisify")
						promisifyNames.add(element.name.text);
			}
			if (INTERNAL_GIT_MODULE.test(spec) && bindings !== undefined && ts.isNamespaceImport(bindings))
				internalGitNamespaces.add(bindings.name.text);
			for (const element of named)
				if (!element.isTypeOnly && (element.propertyName ?? element.name).text === "internalGitArgv")
					reportInternalGitArgv(element, "imports");
		} else if (
			ts.isExportDeclaration(statement) &&
			!statement.isTypeOnly &&
			statement.moduleSpecifier !== undefined &&
			ts.isStringLiteral(statement.moduleSpecifier)
		) {
			if (statement.exportClause === undefined && INTERNAL_GIT_MODULE.test(statement.moduleSpecifier.text))
				reportInternalGitArgv(statement, "re-exports");
			else if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause))
				for (const element of statement.exportClause.elements)
					if (!element.isTypeOnly && (element.propertyName ?? element.name).text === "internalGitArgv")
						reportInternalGitArgv(element, "re-exports");
		}
	}
	const fromChildProcess = (callee: ts.Expression): boolean => {
		const expr = unwrapExpression(callee);
		if (ts.isIdentifier(expr)) return childProcessNames.has(expr.text);
		if (ts.isPropertyAccessExpression(expr)) {
			const owner = unwrapExpression(expr.expression);
			if (ts.isIdentifier(owner) && childProcessNames.has(owner.text)) return true;
			const spec = dynamicImportSpecifier(owner);
			return spec !== undefined && CHILD_PROCESS_MODULES.has(spec);
		}
		if (ts.isCallExpression(expr) && expr.arguments.length > 0) {
			const fn = unwrapExpression(expr.expression);
			const isPromisify =
				(ts.isIdentifier(fn) && promisifyNames.has(fn.text)) ||
				(ts.isPropertyAccessExpression(fn) &&
					fn.name.text === "promisify" &&
					ts.isIdentifier(unwrapExpression(fn.expression)) &&
					utilNamespaces.has((unwrapExpression(fn.expression) as ts.Identifier).text));
			if (isPromisify) return fromChildProcess(expr.arguments[0] as ts.Expression);
		}
		return false;
	};
	const visitDeclarations = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
			const init = unwrapExpression(node.initializer);
			const dynamicSpec = dynamicImportSpecifier(init);
			if (ts.isIdentifier(node.name)) {
				if (ts.isStringLiteralLike(init) && init.text === "git") gitNames.add(node.name.text);
				else if (isGitCommandLiteral(init)) gitCommandLines.add(node.name.text);
				else if (dynamicSpec !== undefined && CHILD_PROCESS_MODULES.has(dynamicSpec)) childProcessNames.add(node.name.text);
				else if (dynamicSpec !== undefined && INTERNAL_GIT_MODULE.test(dynamicSpec))
					internalGitNamespaces.add(node.name.text);
				else if (fromChildProcess(init)) childProcessNames.add(node.name.text);
			} else if (ts.isObjectBindingPattern(node.name) && dynamicSpec !== undefined) {
				if (CHILD_PROCESS_MODULES.has(dynamicSpec))
					for (const element of node.name.elements)
						if (ts.isIdentifier(element.name)) childProcessNames.add(element.name.text);
				if (INTERNAL_GIT_MODULE.test(dynamicSpec))
					for (const element of node.name.elements) {
						const prop = element.propertyName ?? element.name;
						if (ts.isIdentifier(prop) && prop.text === "internalGitArgv") reportInternalGitArgv(element, "imports");
					}
			}
		}
		ts.forEachChild(node, visitDeclarations);
	};
	visitDeclarations(tree);
	const calleeName = (callee: ts.Expression): string => {
		const expr = unwrapExpression(callee);
		return ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? expr.name.text : expr.getText(tree);
	};
	const isGitProgram = (arg: ts.Expression): boolean => {
		const expr = unwrapExpression(arg);
		return (ts.isStringLiteralLike(expr) && expr.text === "git") || (ts.isIdentifier(expr) && gitNames.has(expr.text));
	};
	const visit = (node: ts.Node): void => {
		if (ts.isPropertyAccessExpression(node) && node.name.text === "internalGitArgv") {
			const owner = unwrapExpression(node.expression);
			const spec = dynamicImportSpecifier(owner);
			if (
				(ts.isIdentifier(owner) && internalGitNamespaces.has(owner.text)) ||
				(spec !== undefined && INTERNAL_GIT_MODULE.test(spec))
			)
				reportInternalGitArgv(node, "uses");
		}
		if (ts.isCallExpression(node) && node.arguments.length > 0) {
			const callee = calleeName(node.expression);
			const programAt = GIT_PROGRAM_ARG_INDEX.get(callee) ?? 0;
			const programArg = node.arguments[programAt];
			const program =
				programArg !== undefined &&
				isGitProgram(programArg) &&
				(node.arguments.length > programAt + 1 || fromChildProcess(node.expression));
			const first = unwrapExpression(node.arguments[0] as ts.Expression);
			const commandLine =
				(isGitCommandLiteral(first) || (ts.isIdentifier(first) && gitCommandLines.has(first.text))) &&
				fromChildProcess(node.expression);
			if ((program || commandLine) && !GIT_WORD_CALLEES.has(callee)) {
				const key = `${file}#${callee}`;
				if (GIT_SPAWN_EXEMPTIONS.some((entry) => entry.file === file && entry.callee === callee)) usedExemptions?.add(key);
				else
					violations.push(
						`rule24: ${file}:${line(node)} starts git through ${callee}; PanCode's own git goes through ${GIT_RUNNER} (gitVia for another runner), or exempt the call with its reason in GIT_SPAWN_EXEMPTIONS`,
					);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return violations;
}

/** One value import: a static, side-effect or re-export declaration, or a dynamic `import()`. */
interface ValueImport {
	specifier: string;
	line: number;
}

/**
 * The relative value imports of a file, read from its syntax tree. A declaration is type-only when it says
 * `import type` or `export type`, or when every named binding it lists is marked `type`; esbuild erases those.
 */
function relativeValueImports(file: string, source: string): ValueImport[] {
	const tree = parseTree(file, source);
	const imports: ValueImport[] = [];
	const add = (specifier: string, node: ts.Node): void => {
		if (specifier.startsWith("."))
			imports.push({ specifier, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 });
	};
	const allTyped = (elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>): boolean =>
		elements.length > 0 && elements.every((element) => element.isTypeOnly);
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const clause = node.importClause;
			const typeOnly =
				clause !== undefined &&
				(clause.isTypeOnly ||
					(clause.name === undefined &&
						clause.namedBindings !== undefined &&
						ts.isNamedImports(clause.namedBindings) &&
						allTyped(clause.namedBindings.elements)));
			if (!typeOnly) add(node.moduleSpecifier.text, node);
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			const typeOnly =
				node.isTypeOnly ||
				(node.exportClause !== undefined && ts.isNamedExports(node.exportClause) && allTyped(node.exportClause.elements));
			if (!typeOnly) add(node.moduleSpecifier.text, node);
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments[0] !== undefined &&
			ts.isStringLiteralLike(node.arguments[0])
		) {
			add(node.arguments[0].text, node);
		}
		ts.forEachChild(node, visit);
	};
	visit(tree);
	return imports;
}

/**
 * The lifecycle domains, each with its `dependsOn` taken transitively: a domain is one when its `manifest.ts` declares
 * `dependsOn` as an array of names.
 */
function lifecycleDependencies(domainsRoot: string): Map<string, Set<string>> {
	const declared = new Map<string, string[]>();
	for (const name of readdirSync(domainsRoot)) {
		const manifest = path.join(domainsRoot, name, "manifest.ts");
		if (!statSync(manifest, { throwIfNoEntry: false })?.isFile()) continue;
		const visit = (node: ts.Node): void => {
			if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "dependsOn") {
				let value = node.initializer;
				while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value)) value = value.expression;
				if (ts.isArrayLiteralExpression(value))
					declared.set(
						name,
						value.elements.filter(ts.isStringLiteralLike).map((element) => element.text),
					);
				return;
			}
			ts.forEachChild(node, visit);
		};
		visit(parseTree(manifest, readFileSync(manifest, "utf8")));
	}
	const closure = new Map<string, Set<string>>();
	for (const name of declared.keys()) {
		const reached = new Set<string>();
		const stack = [...(declared.get(name) ?? [])];
		while (stack.length > 0) {
			const next = stack.pop() as string;
			if (reached.has(next)) continue;
			reached.add(next);
			stack.push(...(declared.get(next) ?? []));
		}
		closure.set(name, reached);
	}
	return closure;
}

/** The import sites behind each rule25 key, `file:line` each. */
type LayerEdges = Map<string, string[]>;

/**
 * rule25 for one file. (a) A file under src/core or src/lib value-imports only src/core and src/lib, keyed
 * `importer file -> target unit` (`src/domains/<name>` or `src/<layer>`). (b) A file under src/domains/<x>
 * value-imports src/domains/<y> only as src/domains/<y>/index.ts, keyed `src/domains/<x> -> src/domains/<y>`. (c) A
 * value import between two lifecycle domains needs the target in the importer's transitive `dependsOn`, keyed
 * `<x> -> <y>`. The caller sums each part over the tree and holds it to LAYER_EXEMPTIONS.
 */
function collectLayerEdges(
	projectRoot: string,
	filePath: string,
	source: string,
	lifecycle: ReadonlyMap<string, ReadonlySet<string>>,
	edges: { core: LayerEdges; barrel: LayerEdges; dependsOn: LayerEdges },
): void {
	const srcRoot = path.join(projectRoot, "src");
	const display = (file: string): string => path.relative(projectRoot, file).split(path.sep).join("/");
	const unitOf = (file: string): string | null => {
		const parts = display(file).split("/");
		if (parts[0] !== "src" || parts.length < 3) return null;
		return parts[1] === "domains" || parts[1] === "lib" ? `src/${parts[1]}/${parts[2]}` : `src/${parts[1]}`;
	};
	const from = unitOf(filePath);
	if (from === null) return;
	const low = (unit: string): boolean => unit === "src/core" || unit.startsWith("src/lib/");
	const fromDomain = from.startsWith("src/domains/") ? from.slice("src/domains/".length) : null;
	if (!low(from) && fromDomain === null) return;
	const record = (map: LayerEdges, key: string, site: string): void => {
		const sites = map.get(key) ?? [];
		sites.push(site);
		map.set(key, sites);
	};
	for (const { specifier, line } of relativeValueImports(filePath, source)) {
		const resolved = resolveRelativeImport(filePath, specifier);
		if (!isWithin(resolved, srcRoot)) continue;
		const to = unitOf(resolved);
		if (to === null || to === from) continue;
		const site = `${display(filePath)}:${line}`;
		if (low(from) && !low(to)) record(edges.core, `${display(filePath)} -> ${to}`, site);
		if (fromDomain === null || !to.startsWith("src/domains/")) continue;
		const toDomain = to.slice("src/domains/".length);
		if (display(resolved) !== `${to}/index.ts`) record(edges.barrel, `${from} -> ${to}`, site);
		const declared = lifecycle.get(fromDomain);
		if (declared !== undefined && lifecycle.has(toDomain) && !declared.has(toDomain))
			record(edges.dependsOn, `${fromDomain} -> ${toDomain}`, site);
	}
}

/**
 * rule25 over the tree: each part's edges against its shrink-only LAYER_EXEMPTIONS map, the rule23 pattern. A key
 * not listed fails, a count over its entry fails, a count under its entry fails until the entry is lowered, and an
 * entry with no edge left fails until it is removed.
 */
function checkLayerEdges(edges: { core: LayerEdges; barrel: LayerEdges; dependsOn: LayerEdges }): string[] {
	const parts = [
		{
			part: "25a",
			found: edges.core,
			allowed: LAYER_EXEMPTIONS.core,
			name: "core",
			rule:
				"src/core and src/lib value-import only src/core and src/lib; move the imported value down into core or lib, or move the importer up to its owner",
		},
		{
			part: "25b",
			found: edges.barrel,
			allowed: LAYER_EXEMPTIONS.barrel,
			name: "barrel",
			rule:
				"a domain value-imports another domain only through that domain's index.ts; import it from the index, exporting it there if the domain means to publish it",
		},
		{
			part: "25c",
			found: edges.dependsOn,
			allowed: LAYER_EXEMPTIONS.dependsOn,
			name: "dependsOn",
			rule:
				"a lifecycle domain value-imports another only when its manifest's dependsOn reaches it; declare the dependency if the order allows it, or cut the import",
		},
	];
	const violations: string[] = [];
	for (const { part, found, allowed, name, rule } of parts) {
		for (const [key, sites] of [...found.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			const limit = allowed.get(key);
			if (limit === undefined)
				violations.push(`rule${part}: ${key}: ${sites.length} value import(s) at ${sites.join(", ")}; ${rule}`);
			else if (sites.length > limit)
				violations.push(
					`rule${part}: ${key} grew to ${sites.length} value imports, past the ${limit} LAYER_EXEMPTIONS.${name} allows (${sites.join(", ")}); an entry may only shrink: ${rule}`,
				);
			else if (sites.length < limit)
				violations.push(
					`rule${part}: LAYER_EXEMPTIONS.${name} allows ${key} ${limit} value imports and it now has ${sites.length}; lower the entry to ${sites.length} (tests/boundaries/layer-exemptions.ts)`,
				);
		}
		for (const key of allowed.keys())
			if (!found.has(key))
				violations.push(
					`rule${part}: LAYER_EXEMPTIONS.${name} lists ${key}, which has no value import left; remove the entry (tests/boundaries/layer-exemptions.ts)`,
				);
	}
	return violations;
}

/**
 * Enforce the static isolation rules:
 *   1. Only src/engine/** may import @earendil-works/pi-* at all. Since the
 *      0.83.0 engine-boundary rework there is no type-only exception either:
 *      domains take erased engine shapes from src/engine/types.ts.
 *   2. src/worker/** never value-imports src/domains/** EXCEPT the worker-safe
 *      provider runtime registry, builtin descriptors, and plugin loader used
 *      to rehydrate runtime descriptors from stdin. Type-only imports are
 *      allowed because they erase at compile time.
 *   2b. The static value-import closure of src/worker/entry.ts contains no
 *      domain bundle (any domain's extension.ts), telemetry/read-model.ts,
 *      memory/intervention.ts, context/wiki/** or core/settings-controls.ts.
 *      Those are orchestrator-only; a worker reaches them by dynamic import
 *      at most, so they never load before the worker reads its spec.
 *   3. src/domains/<x> never imports src/domains/<y>/extension.ts for y != x.
 *   7. src/domains/turn-control/** imports no interactive, engine, tools or
 *      worker modules, and reaches other domains only through index.ts.
 *   4. src/tools/** never imports src/interactive/**. The tool substrate is
 *      surface-agnostic: headless, interactive, ACP, and worker runs share it,
 *      so a tool reaching into TUI code would make one surface's presentation
 *      a dependency of every surface's execution.
 *   5. The chat loop's turn modules (src/session-control/turn-*.ts,
 *      chat-loop.ts) never import src/entry/**. Composition flows one way: the
 *      entry point composes the loop, never the reverse.
 *   8. src/session-control/** never imports src/interactive/**, type-only
 *      included. It is the one session contract the TUI, headless run and the
 *      ACP server all call, so a render module in its graph would make the
 *      terminal a dependency of every surface.
 *  10. Root and GUI monetary display uses core/telemetry/render.ts;
 *      browser code consumes display strings rendered by the server.
 *  14. src/interactive/**, src/engine/acp/** and src/cli/** sum no token or
 *      cost field: their figures are the read model's quantity displays,
 *      except the functions SURFACE_TOTAL_EXEMPTIONS names with a reason.
 *  16. Only src/session-control/chat-loop.ts (the composer) and turn-state.ts
 *      name ChatTurnState; every other turn module takes the view
 *      turn-state.ts declares for it. Under src/session-control/** nothing
 *      outside turn-state.ts assigns a continuation field: ContinuationState's
 *      methods are its only writers.
 *  17. A domain owner's capability (the middleware registrar, the telemetry
 *      run-reader binder) is named only inside its domain and by the
 *      OWNER_CAPABILITY_HOLDERS, and no getContract call passes a type
 *      argument: a published contract cannot install another domain's
 *      behavior, and its type comes from DomainContractMap.
 *   9. src/engine/** never imports src/interactive/**, type-only included.
 *      The ACP server reaches session behavior through src/session-control.
 *   6. Any value importer outside the computed Stage 0 closure and its
 *      src/interactive/**, src/session-control/** and src/engine/** trees
 *      reaches those trees only
 *      through a declared seam in STAGE0_SEAMS. A seam may not lead back into
 *      Stage 0 unless that existing composition-root overlap is explicitly
 *      declared. CLI type edges retain the older declaration requirement.
 *      Both halves protect the instant shell's cold-start chunk graph, pinned by
 *      tests/contracts/instant-shell-import-graph.test.ts.
 *  19, 20, 21. Workspace packages under packages/ stay independent of the
 *      harness and of each other's internals (checkPackageBoundaries).
 *  22. src/core/views/** is the presentation the terminal and the GUI client
 *      share, and the client imports it directly. It value-imports only within
 *      itself, takes types only from src/**, and imports no Node builtin, no
 *      package and no pi-* module, type-only included.
 *  23. No function under src/ spans more than FUNCTION_LINE_CEILING lines,
 *      except those FUNCTION_LINE_EXEMPTIONS lists, each held at its size.
 *  24. PanCode starts git only through src/core/internal-git-run.ts, which
 *      hardens every argv with internalGitArgv: no other call in src/ passes
 *      git as the program, and only the runner imports internalGitArgv, except
 *      the calls GIT_SPAWN_EXEMPTIONS names with a reason.
 *  25. The layers, on value imports (static, dynamic, side-effect and
 *      re-export; type-only erases): (a) src/core and src/lib import only
 *      src/core and src/lib; (b) a domain imports another domain only through
 *      its index.ts; (c) a lifecycle domain imports another lifecycle domain
 *      only when its manifest's dependsOn reaches it. The edges each part had
 *      when the rule landed are counted in LAYER_EXEMPTIONS, and a count only
 *      falls.
 */
export function runBoundaryCheck(projectRoot: string): BoundaryCheckResult {
	const srcRoot = path.join(projectRoot, "src");
	const engineRoot = path.join(srcRoot, "engine");
	const workerRoot = path.join(srcRoot, "worker");
	const domainsRoot = path.join(srcRoot, "domains");
	const providersDomainRoot = path.join(domainsRoot, "providers");
	const toolsRoot = path.join(srcRoot, "tools");
	const interactiveRoot = path.join(srcRoot, "interactive");
	const sessionControlRoot = path.join(srcRoot, "session-control");
	const entryRoot = path.join(srcRoot, "entry");
	const cliRoot = path.join(srcRoot, "cli");
	const viewsRoot = path.join(srcRoot, "core", "views");
	const stage0Owner = path.join(projectRoot, STAGE_0_OWNER);
	const stage0Closure = valueImportClosure(stage0Owner);

	const violations: string[] = [...checkWorkerClosure(projectRoot)];
	/** Runtime importers by declared seam, so rule 6b can disposition each reacher. */
	const valueReachedSeams = new Map<string, Set<string>>();
	const usedSurfaceExemptions = new Set<string>();
	const usedCapabilityHolders = new Set<string>();
	const seenFunctionExemptions = new Set<string>();
	const usedGitSpawnExemptions = new Set<string>();
	const lifecycle = lifecycleDependencies(domainsRoot);
	const layerEdges = { core: new Map(), barrel: new Map(), dependsOn: new Map() } satisfies Parameters<
		typeof checkLayerEdges
	>[0];

	for (const filePath of walk(srcRoot)) {
		const source = readFileSync(filePath, "utf8");
		collectLayerEdges(projectRoot, filePath, source, lifecycle, layerEdges);
		violations.push(...checkCostRendering(path.relative(projectRoot, filePath).split(path.sep).join("/"), source));
		violations.push(...checkLedgerUsageMutation(path.relative(projectRoot, filePath).split(path.sep).join("/"), source));
		violations.push(...checkTelemetryWrites(path.relative(projectRoot, filePath).split(path.sep).join("/"), source));
		violations.push(...checkLedgerUsageKeys(path.relative(projectRoot, filePath).split(path.sep).join("/"), source));
		violations.push(...checkTurnStateOwnership(path.relative(projectRoot, filePath).split(path.sep).join("/"), source));
		violations.push(...checkRecipeIdBranches(path.relative(projectRoot, filePath).split(path.sep).join("/"), source));
		violations.push(
			...checkFunctionLengths(
				path.relative(projectRoot, filePath).split(path.sep).join("/"),
				source,
				seenFunctionExemptions,
			),
		);
		violations.push(
			...checkGitSpawns(path.relative(projectRoot, filePath).split(path.sep).join("/"), source, usedGitSpawnExemptions),
		);
		violations.push(
			...checkSurfaceTotals(path.relative(projectRoot, filePath).split(path.sep).join("/"), source, usedSurfaceExemptions),
		);
		violations.push(
			...checkDomainContractAccess(
				path.relative(projectRoot, filePath).split(path.sep).join("/"),
				source,
				usedCapabilityHolders,
			),
		);
		const specifiers = extractSpecifiers(source);
		const references = extractReferenceDirectives(source);

		const inEngine = isWithin(filePath, engineRoot);
		const inInteractive = isWithin(filePath, interactiveRoot);
		const inWorker = isWithin(filePath, workerRoot);
		const fromDomain = domainOf(filePath, domainsRoot);
		const inTools = isWithin(filePath, toolsRoot);
		const inSessionControl = isWithin(filePath, sessionControlRoot);
		const isChatLoopModule = inSessionControl && isChatLoopTurnModule(filePath);
		const inCli = isWithin(filePath, cliRoot);
		const inStage0Closure = stage0Closure.has(filePath);
		const inViews = isWithin(filePath, viewsRoot);

		const evaluate = (specifier: string, typeOnly: boolean, kind: "import" | "reference") => {
			if (inViews) {
				const relativeSpecifier = specifier.startsWith(".") || specifier.startsWith("/");
				const resolved = relativeSpecifier ? resolveRelativeImport(filePath, specifier) : "";
				const allowed = relativeSpecifier && (isWithin(resolved, viewsRoot) || (typeOnly && isWithin(resolved, srcRoot)));
				if (!allowed) {
					const qualifier = typeOnly ? " (type-only)" : "";
					violations.push(
						`rule22: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} ${specifier}; src/core/views is browser-safe presentation the GUI client imports directly, so it value-imports only within itself and takes types only from src/**`,
					);
				}
				return;
			}
			if (specifier.startsWith(piPackagePrefix)) {
				if (!inEngine && !typeOnly) {
					violations.push(
						`rule1: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} outside src/engine (value import)`,
					);
				}
				if (!inEngine && typeOnly && !allowedPiTypeImportSpecifiersOutsideEngine.has(specifier)) {
					violations.push(
						`rule1: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} outside src/engine (type-only import is not explicitly allowed)`,
					);
				}
				return;
			}

			if (!(specifier.startsWith(".") || specifier.startsWith("/"))) return;
			const resolved = resolveRelativeImport(filePath, specifier);
			const targetDomain = domainOf(resolved, domainsRoot);
			if (
				fromDomain === "turn-control" &&
				(isWithin(resolved, interactiveRoot) ||
					isWithin(resolved, engineRoot) ||
					isWithin(resolved, toolsRoot) ||
					isWithin(resolved, workerRoot) ||
					(targetDomain !== null &&
						targetDomain !== fromDomain &&
						resolved !== path.join(domainsRoot, targetDomain, "index.ts")))
			) {
				const qualifier = typeOnly ? " (type-only)" : "";
				violations.push(
					`rule7: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} ${specifier}; turn-control is pure and other domains are accessed only through index.ts`,
				);
				return;
			}

			if (inWorker && isWithin(resolved, domainsRoot)) {
				if (!typeOnly && !isAllowedWorkerProviderValueImport(resolved, providersDomainRoot)) {
					violations.push(
						`rule2: ${path.relative(projectRoot, filePath)} ${kind} ${specifier} which resolves inside src/domains (worker value imports are limited to provider runtime rehydration modules)`,
					);
				}
				return;
			}

			if (inTools && isWithin(resolved, interactiveRoot)) {
				const qualifier = typeOnly ? " (type-only)" : "";
				violations.push(
					`rule4: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} ${specifier} which resolves inside src/interactive; the tool substrate is surface-agnostic`,
				);
				return;
			}

			if ((inSessionControl || inEngine) && isWithin(resolved, interactiveRoot)) {
				const qualifier = typeOnly ? " (type-only)" : "";
				const rule = inSessionControl ? "rule8" : "rule9";
				const owner = inSessionControl ? "the session contract" : "the engine";
				violations.push(
					`${rule}: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} ${specifier} which resolves inside src/interactive; ${owner} is shared by every surface and never depends on terminal rendering`,
				);
				return;
			}

			const protectedTarget =
				isWithin(resolved, interactiveRoot) || isWithin(resolved, sessionControlRoot) || isWithin(resolved, engineRoot);
			const externalRuntimeReacher = !typeOnly && !inInteractive && !inSessionControl && !inEngine && !inStage0Closure;
			if (protectedTarget && (inCli || externalRuntimeReacher)) {
				const seamPath = path.relative(projectRoot, resolved).split(path.sep).join("/");
				const seam = STAGE0_SEAMS_BY_MODULE.get(seamPath);
				if (seam === undefined) {
					const qualifier = typeOnly ? " (type-only)" : "";
					violations.push(
						`rule6: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} ${specifier} which resolves to ${seamPath}; runtime importers outside the computed Stage 0 closure and its src/interactive/** and src/engine/** trees may enter those protected trees only through a seam declared in STAGE0_SEAMS (tests/boundaries/check-boundaries.ts). A new disjoint reacher makes esbuild split the merged chunk the instant shell's Stage 0 closure sits on. That closure is held to 32 chunks, 1,400,000 total bytes and 400,000 PanCode source bytes by tests/contracts/instant-shell-import-graph.test.ts, which only fails after a full build. Move the needed value into a leaf seam, route through an existing seam, or declare a legitimate edge with its reason.`,
					);
				} else if (!typeOnly) {
					const importers = valueReachedSeams.get(resolved) ?? new Set<string>();
					importers.add(filePath);
					valueReachedSeams.set(resolved, importers);
				}
				return;
			}

			if (isChatLoopModule && isWithin(resolved, entryRoot)) {
				const qualifier = typeOnly ? " (type-only)" : "";
				violations.push(
					`rule5: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} ${specifier} which resolves inside src/entry; the entry point composes the chat loop, never the reverse`,
				);
				return;
			}

			if (fromDomain) {
				const toDomain = domainOf(resolved, domainsRoot);
				if (toDomain && toDomain !== fromDomain && resolved.endsWith(`${path.sep}extension.ts`)) {
					const qualifier = typeOnly ? " (type-only)" : "";
					violations.push(
						`rule3: ${path.relative(projectRoot, filePath)} ${kind}${qualifier} reaches into src/domains/${toDomain}/extension.ts; use the contract exported from src/domains/${toDomain}/index.ts instead`,
					);
				}
			}
		};

		for (const { specifier, typeOnly } of specifiers) {
			evaluate(specifier, typeOnly, "import");
		}

		for (const ref of references) {
			if (ref.kind === "types") {
				evaluate(ref.specifier, true, "reference");
			} else {
				const spec = ref.specifier.startsWith(".") || ref.specifier.startsWith("/") ? ref.specifier : `./${ref.specifier}`;
				evaluate(spec, true, "reference");
			}
		}
	}

	// rule6, second half. Declaring a seam is not enough: the imported module
	// drags its own closure along, and that is how the first CLI splits happened.
	// A seam may reach domains, core, and the
	// non-terminal half of the engine freely; what it may not reach is anything
	// the Stage 0 owner already reaches, because that is precisely the set whose
	// chunk membership the instant shell is measured on. The owner itself is the
	// reference point, so its own seam edge is skipped rather than special-cased.
	for (const seam of [...valueReachedSeams.keys()].sort()) {
		if (seam === stage0Owner) continue;
		const reached = [...valueImportClosure(seam)]
			.filter((file) => file !== seam && stage0Closure.has(file))
			.filter(
				(file) => isWithin(file, interactiveRoot) || isWithin(file, sessionControlRoot) || isWithin(file, engineRoot),
			)
			.map((file) => path.relative(projectRoot, file).split(path.sep).join("/"))
			.sort();
		if (reached.length === 0) continue;
		const seamPath = path.relative(projectRoot, seam).split(path.sep).join("/");
		const declaration = STAGE0_SEAMS_BY_MODULE.get(seamPath);
		const allowedOverlapImporters = new Set(declaration?.allowStage0OverlapFrom ?? []);
		const importers = [...(valueReachedSeams.get(seam) ?? [])]
			.map((file) => path.relative(projectRoot, file).split(path.sep).join("/"))
			.filter((file) => !allowedOverlapImporters.has(file))
			.sort();
		if (importers.length === 0) continue;
		violations.push(
			`rule6: seam ${seamPath}, reached by ${importers.join(", ")}, value-imports its way into the Stage 0 closure (${reached.join(", ")}); an external seam must stay off the modules ${STAGE_0_OWNER} already reaches, or its importer becomes a second reacher and esbuild splits their merged chunk. That closure is held to 32 chunks, 1,400,000 total bytes and 400,000 PanCode source bytes by tests/contracts/instant-shell-import-graph.test.ts, which only fails after a full build. Move the value the seam needs into a leaf module instead of importing the render module that happens to hold it.`,
		);
	}

	for (const exemption of SURFACE_TOTAL_EXEMPTIONS)
		for (const fn of exemption.functions)
			if (!usedSurfaceExemptions.has(`${exemption.file}#${fn}`))
				violations.push(
					`rule14: SURFACE_TOTAL_EXEMPTIONS exempts ${exemption.file}#${fn}, which no longer sums a token or cost field; remove the exemption`,
				);

	for (const key of FUNCTION_LINE_EXEMPTIONS.keys())
		if (!seenFunctionExemptions.has(key))
			violations.push(
				`rule23: FUNCTION_LINE_EXEMPTIONS lists ${key}, which names no function; remove the entry, or rekey it to the function's new file or name`,
			);

	for (const holder of OWNER_CAPABILITY_HOLDERS.keys())
		if (!usedCapabilityHolders.has(holder))
			violations.push(
				`rule17: OWNER_CAPABILITY_HOLDERS lists ${holder}, which no longer names that domain's capability; remove the entry`,
			);

	violations.push(...checkLayerEdges(layerEdges));

	for (const exemption of GIT_SPAWN_EXEMPTIONS)
		if (!usedGitSpawnExemptions.has(`${exemption.file}#${exemption.callee}`))
			violations.push(
				`rule24: GIT_SPAWN_EXEMPTIONS exempts ${exemption.file}#${exemption.callee}, which no longer starts git; remove the exemption`,
			);

	for (const directory of ["client", "server"]) {
		for (const file of walk(path.join(projectRoot, "apps/pancode-gui", directory))) {
			const relative = path.relative(projectRoot, file).split(path.sep).join("/");
			const source = readFileSync(file, "utf8");
			violations.push(...checkCostRendering(relative, source));
			if (directory === "server") violations.push(...checkTelemetryWrites(relative, source));
		}
	}
	for (const file of valueImportClosure(path.join(projectRoot, "src/core/telemetry/producer.ts"))) {
		violations.push(...checkTelemetryProducer(path.relative(projectRoot, file), readFileSync(file, "utf8")));
	}
	violations.push(...checkCompositionRoot(ORCHESTRATOR, readFileSync(path.join(projectRoot, ORCHESTRATOR), "utf8")));
	violations.push(...checkPackageBoundaries(projectRoot));
	// A share keeps a field verbatim only where its schema already bounds it (#434).
	violations.push(...shareProjectionErrors().map((error) => `share-projection: ${error}`));
	// A report bundle's envelope leaves whole, so it is held to the same walk (R-17).
	violations.push(
		...closedSchemaErrors(REPORT_BUNDLE_ENVELOPE_SCHEMA, "report.json").map((error) => `report-bundle: ${error}`),
	);
	return { violations };
}
