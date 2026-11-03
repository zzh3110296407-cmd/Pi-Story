export interface P1RunResult {
	passed: boolean;
	manifest: { status: string; [key: string]: unknown };
	metrics: {
		metrics: { passed: boolean | null; classificationGatePassed?: boolean; [key: string]: unknown }[];
		[key: string]: unknown;
	};
}
export function runSuite(suite: string, options?: { reproduceRoot?: string; createJudgments?: boolean }): P1RunResult;
