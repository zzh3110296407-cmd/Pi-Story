export interface DatasetManifest {
	schema: "story/dataset-manifest@1";
	id: string;
	version: string;
	frozenAt: string;
	files: { path: string; sha256: string; source: string; license: string; split: string }[];
}
export function sha256(value: string | Uint8Array): string;
export function verifyDataset(
	root: string,
	directory: string,
	version?: string,
): { folder: string; manifest: DatasetManifest; manifestDigest: string };
