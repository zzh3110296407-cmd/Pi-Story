import type { Settings } from "../packages/pi-story/src/ports.ts";
export const PI_COMMIT: string;
export function piModelOverrides(): {
	providers: { deepseek: { modelOverrides: { "deepseek-v4-pro": { thinkingLevelMap: { low: "low" } } } } };
};
export function settingsTemplate(workDir: string): Settings["global"];
export function runtimeEnvironment(
	workDir: string,
	source?: Record<string, string | undefined>,
): Record<string, string>;
export function copyModelSnapshot(
	source: string,
	target: string,
): { manifestSha256: string; files: Record<string, string> };
