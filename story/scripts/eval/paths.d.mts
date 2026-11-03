export const repository: string;
export function testingPaths(env?: NodeJS.ProcessEnv): { testRoot: string; runsRoot: string; workDir: string };
export function inside(folder: string, target: string): boolean;
export function hasSourceChanges(root?: string): boolean;
export function sourceEvidence(
	root?: string,
	env?: NodeJS.ProcessEnv,
): { commit: string; dirty: boolean; archive: boolean };
