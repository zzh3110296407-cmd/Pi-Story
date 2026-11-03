export interface BaselineEntry {
	file: string;
	mode: "100644" | "100755" | "120000";
	oid: string;
}
export interface SourceBaseline {
	schema: "story/git-tree-baseline@1";
	commit: string;
	entries: BaselineEntry[];
	prefixes?: string[];
}
export const UPSTREAM_BASELINE: string;
export function readBaseline(file: string | URL): SourceBaseline;
export function gitTree(repositoryRoot: string, revision: string, prefixes?: string[]): BaselineEntry[];
export function assertFrozenTree(repositoryRoot: string, baselineFile: string, revision?: string): string;
export function inspectUpstream(repositoryRoot: string): {
	baseline: string;
	violations: { layer: string; files: string[] }[];
};
