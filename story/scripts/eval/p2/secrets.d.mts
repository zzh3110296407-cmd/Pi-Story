export interface SecretScan {
	schema: string;
	scopes: string[];
	method: string;
	files: number;
	bytes: number;
	hits: { path: string; line: number; category: string; candidateDigest: string }[];
	syntheticFixtures: { path: string; line: number; category: string; candidateDigest: string; reason: string }[];
	environmentFiles: { path: string; read: false; knownSynthetic: boolean }[];
	skippedLinks: string[];
	passed: boolean;
}
export function scanSecrets(scopes: string[], repository: string): SecretScan;
