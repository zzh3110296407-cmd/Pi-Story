import type { BranchEntry } from "@pi-story/core";

export interface ContextPredicate {
	type: "json_path_exists" | "text_contains" | "field_absent" | "text_absent";
	value: string;
}
export interface ContextCase {
	id: string;
	entries: BranchEntry[];
	role: "writer" | "patch" | "editor" | "recheck" | "keeper";
	chapter: number;
	must: ContextPredicate[];
	forbidden: ContextPredicate[];
}
export function contextInput(scenario: ContextCase): unknown;
export function contextPredicates(
	value: unknown,
	predicates: readonly ContextPredicate[],
): (ContextPredicate & { passed: boolean })[];
