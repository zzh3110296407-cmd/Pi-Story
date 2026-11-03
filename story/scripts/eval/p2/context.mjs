import { foldBranch } from "@pi-story/core";
import { editorInput, keeperInput, patchInput, writerInput } from "../../../packages/core/src/flow/inputs.ts";

// Reuse the exact core constructors used by the extension's macro, not copies of prompts.
export function contextInput(scenario) {
	const model = foldBranch(scenario.entries);
	if (scenario.role === "writer") return writerInput(model);
	const draft = model.drafts.filter((draft) => draft.chapter === scenario.chapter).at(-1);
	if (!draft) throw new Error(`Missing context draft: ${scenario.id}`);
	const review = model.reviews.filter((review) => review.draftId === draft.draftId).at(-1);
	const observations = review?.observations ?? [];
	if (scenario.role === "patch") return patchInput(model, draft, observations);
	if (scenario.role === "keeper") return keeperInput(model, draft);
	if (scenario.role === "editor") return editorInput(model, draft, "full");
	if (scenario.role === "recheck")
		return editorInput(
			model,
			draft,
			{
				spans: observations.flatMap((item) => item.evidence.lines.map((line) => ({ startLine: line, endLine: line }))),
				forObservations: observations.map((item) => item.id),
			},
			observations,
		);
	throw new Error(`Unknown context role: ${scenario.role}`);
}

export function contextPredicates(value, predicates) {
	const serialized = JSON.stringify(value);
	const input = JSON.parse(serialized);
	const containsField = (node, name) => {
		if (Array.isArray(node)) return node.some((item) => containsField(item, name));
		return (
			node !== null &&
			typeof node === "object" &&
			(Object.hasOwn(node, name) || Object.values(node).some((item) => containsField(item, name)))
		);
	};
	return predicates.map((predicate) => {
		let passed;
		if (predicate.type === "text_contains" || predicate.type === "text_absent") {
			const found = serialized.includes(JSON.stringify(predicate.value).slice(1, -1));
			passed = predicate.type === "text_contains" ? found : !found;
		} else if (predicate.type === "field_absent") passed = !containsField(input, predicate.value);
		else if (predicate.type === "json_path_exists") {
			if (!/^\$(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\]|\[\*\])*$/u.test(predicate.value))
				throw new Error("Unsupported context JSON path");
			let nodes = [input];
			for (const token of predicate.value.slice(1).matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+|\*)\]/gu)) {
				const key = token[1] ?? token[2];
				nodes = nodes.flatMap((node) => {
					if (key === "*") return Array.isArray(node) ? node : [];
					return node !== null && typeof node === "object" && Object.hasOwn(node, key) ? [node[key]] : [];
				});
			}
			passed = nodes.length > 0;
		} else throw new Error(`Unsupported context predicate: ${predicate.type}`);
		return { ...predicate, passed };
	});
}
