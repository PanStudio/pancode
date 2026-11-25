// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** A route's shape: its verb, path, schemas and status, and the presets most routes start from. */
import { type Static, type TSchema, Type } from "typebox";
import { Empty, Id } from "./common.js";

export interface Route<
	P extends TSchema = TSchema,
	Q extends TSchema = TSchema,
	B extends TSchema = TSchema,
	R extends TSchema = TSchema,
> {
	method: "GET" | "POST" | "PATCH" | "DELETE";
	path: string;
	params: P;
	query: Q;
	body: B;
	response: R;
	status: 200 | 202;
	summary: string;
	stream?: true;
}
export function defineRoute<P extends TSchema, Q extends TSchema, B extends TSchema, R extends TSchema>(
	route: Route<P, Q, B, R>,
): Route<P, Q, B, R> {
	return route;
}
export type Input<R extends Route> = {
	params: Static<R["params"]>;
	query: Static<R["query"]>;
	body: Static<R["body"]>;
};
export type Output<R extends Route> = Static<R["response"]>;
export const operationParams = Type.Object({ id: Id }, { additionalProperties: false });
export const get = { method: "GET", params: Empty, query: Empty, body: Empty, status: 200 } as const;
export const post = { method: "POST", query: Empty, body: Empty, status: 202 } as const;
