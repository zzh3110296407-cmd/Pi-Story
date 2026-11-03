import { loadScenarios } from "../p3/datasets.ts";

// All V5 acceptance callers enter here before touching the index. Dataset
// freezing alone cannot authorize reading acceptance during development.
export function loadV5Scenarios(
	version: string,
	split: "dev" | "acceptance",
	freeze?: { schema: "story/p3-v5@1"; commit: string },
) {
	if (split === "acceptance" && (freeze?.schema !== "story/p3-v5@1" || !/^[a-f0-9]{40}$/u.test(freeze.commit)))
		throw new Error("V5 product freeze required before opening acceptance");
	return loadScenarios(version, split, freeze);
}
