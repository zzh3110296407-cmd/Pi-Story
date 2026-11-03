import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { sha256, verifyDataset } from "../../../scripts/eval/datasets.mjs";
import { validateDelta } from "../src/canon/delta.ts";
import { foldBranch } from "../src/fold/index.ts";
import { type DeltaProposal, schemas, validate } from "../src/schema/index.ts";
import { digest, sentences, wordCount } from "../src/shared/text.ts";
import { basis, commitRecord, tool } from "./fixtures.ts";
import { record, testRoot } from "./support/datasets.ts";

interface Pair {
	id: string;
	requestFile: string;
	responseFile: string;
	chapter: number;
	pass: string;
	repairs: string | null;
	requestSha256: string;
	responseSha256: string;
}
interface Judgment {
	id: string;
	expectedClassification: string;
	expectedErrorCode: string;
	semanticReviewScope: string;
	semanticFindings: { code: string; path: string; originalMode: string; evidence: number[] }[];
}
interface Correction {
	sourceId: string;
	sourceResponseSha256: string;
	removedProposal: DeltaProposal["facts"][number];
	proposal: DeltaProposal;
	excludedEstimate: {
		evidence: number[];
		suggestedRepresentation: { characterId: string | null; kind: string; via: string };
	};
}
const { folder, manifest } = verifyDataset(testRoot, "DS07-replay", "v3");
function json<T>(file: string): T {
	if (!manifest.files.some((f) => f.path === file)) throw new Error(`Unregistered replay asset: ${file}`);
	return JSON.parse(readFileSync(path.join(folder, file), "utf8")) as T;
}
const pairs = json<Pair[]>("pairs.json");
const judgments = json<Judgment[]>("judgments.json");
const corrections = json<Correction[]>("corrections.json");
test("P0 V19 all 37 original responses replay with explicit contract and evidence mappings", () => {
	expect(pairs).toHaveLength(37);
	expect(judgments).toHaveLength(37);
	expect(new Set(judgments.map((row) => row.id)).size).toBe(37);
	expect(corrections.map((row) => row.sourceId.slice(-3)).sort()).toEqual(["021", "035"]);
	for (const pair of pairs) {
		const judgment = judgments.find((row) => row.id === pair.id);
		if (!judgment) throw new Error("Missing independent replay judgment");
		expect(sha256(readFileSync(path.join(folder, pair.requestFile)))).toBe(pair.requestSha256);
		expect(sha256(readFileSync(path.join(folder, pair.responseFile)))).toBe(pair.responseSha256);
		const source = pair.repairs ? pairs.find((p) => p.id === pair.repairs) : pair;
		if (!source) throw new Error("Missing repair parent");
		const request = json<{ messages: { role: string; content: string }[] }>(source.requestFile);
		const response = json<{ response: { content: { type: string; text?: string }[] } }>(pair.responseFile);
		const original = request.messages
			.find((m) => m.role === "user")
			?.content.split(`Numbered chapter ${pair.chapter}:\n`)[1];
		if (!original) throw new Error("Missing original numbered chapter");
		const units = [...original.matchAll(/^\[(\d+)\] (.*)$/gmu)].map((m) => ({ n: Number(m[1]), text: m[2] }));
		expect(units.length).toBeGreaterThan(0);
		const text = units.map((u) => u.text).join("\n"),
			parts = sentences(text, pair.chapter);
		const mapping = new Map<number, number[]>();
		let start = 0;
		for (const u of units) {
			mapping.set(
				u.n,
				parts.flatMap((s, i) => (s.start >= start && s.end <= start + u.text.length ? [i + 1] : [])),
			);
			start += u.text.length + 1;
		}
		const output = response.response.content
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
		let raw: unknown;
		try {
			raw = JSON.parse(output);
		} catch {
			raw = null;
		}
		const rawSchema = validate(schemas.DeltaProposal, raw);
		const mapped = structuredClone(raw) as Record<string, unknown> | null;
		const adaptations: string[] = [];
		if (mapped && Array.isArray(mapped.facts))
			for (const row of mapped.facts as Record<string, unknown>[]) {
				if (row.certainty === "confirmed" && row.uncertainReason === "") {
					delete row.uncertainReason;
					adaptations.push("omit P0 confirmed uncertainReason empty string");
				}
				if (Array.isArray(row.sentences)) {
					row.sentences = row.sentences.flatMap((n: unknown) =>
						typeof n === "number" ? (mapping.get(n) ?? [n]) : [n],
					);
				}
			}
		const schema = validate(schemas.DeltaProposal, mapped);
		const entries = Array.from({ length: pair.chapter - 1 }, (_, i) =>
			tool(`prior-${i + 1}`, "commit_chapter", {
				schema: "story/commit-result@1",
				ok: true,
				commit: commitRecord(i + 1),
				calls: [],
			}),
		);
		const model = foldBranch(entries);
		const draft = {
			schema: "story/draft@1" as const,
			draftId: `c${String(pair.chapter).padStart(2, "0")}-d01`,
			chapter: pair.chapter,
			author: "writer" as const,
			text,
			digest: digest(text),
			sentenceRule: "s1" as const,
			basis: basis(),
			wordCount: wordCount(text),
			calls: [],
		};
		const result = validateDelta(model, draft, mapped);
		const paths = result.ok ? [] : (result.error.items ?? []).map((s) => s.split(": ")[0]);
		const subset = result.ok
			? false
			: paths.every((p) => p.startsWith("summary.characters") || /^facts\[\d+\]\.(?:subject|object)$/u.test(p));
		const classification = result.ok ? null : subset ? "subset_difference" : "rule_finding";
		expect(classification, pair.id).toBe(judgment.expectedClassification);
		expect(result.ok ? null : result.error.code, pair.id).toBe(judgment.expectedErrorCode);
		for (const finding of judgment.semanticFindings) {
			const sourceFact = (raw as DeltaProposal).facts[2];
			expect(sourceFact.mode).toBe(finding.originalMode);
			expect(sourceFact.sentences).toEqual(finding.evidence);
			expect(
				units
					.filter((unit) => finding.evidence.includes(unit.n))
					.map((unit) => unit.text)
					.join(" "),
			).toContain("would need decades");
		}
		const correction = corrections.find((row) => row.sourceId === pair.id);
		if (correction) {
			const original = raw as DeltaProposal;
			expect(correction.sourceResponseSha256).toBe(pair.responseSha256);
			expect(correction.removedProposal).toEqual(original.facts[2]);
			expect(correction.excludedEstimate.evidence).toEqual([9, 10, 11]);
			expect(correction.excludedEstimate.suggestedRepresentation).toEqual({
				kind: "believes",
				via: "inferred",
				characterId: null,
			});
			const retained = structuredClone(original.facts.filter((_row, index) => index !== 2));
			for (const row of retained)
				if (row.certainty === "confirmed" && row.uncertainReason === "") delete row.uncertainReason;
			expect(correction.proposal.facts).toEqual(retained);
			expect(validate(schemas.DeltaProposal, correction.proposal).ok).toBe(true);
			const correctedResult = validateDelta(model, draft, correction.proposal);
			expect(correctedResult).toMatchObject({
				ok: false,
				error: { code: "DOMAIN_INVALID", items: ["summary.characters"] },
			});
			record("replay-correction", {
				sourceId: pair.id,
				schemaOk: true,
				domainOk: false,
				result: correctedResult,
				countedAsModelSuccess: false,
			});
		}
		const reason = result.ok
			? "Accepted under full P1 contract"
			: subset
				? "P0 supplies free-text entities and no P1 Bible; no identity/card has been invented for replay."
				: "Full P1 validator rejected the original proposal; inspect errors and original evidence before author classification.";
		record("replay", {
			id: pair.id,
			pass: pair.pass,
			repairs: pair.repairs,
			chapter: pair.chapter,
			rawSchemaOk: rawSchema.ok,
			schemaOk: schema.ok,
			domainOk: result.ok,
			classification,
			reason,
			adaptations: [...new Set(adaptations)],
			originalEvidenceMapping: Object.fromEntries(mapping),
			rawSchemaErrors: rawSchema.ok ? [] : rawSchema.errors,
			result,
			expectedClassification: judgment.expectedClassification,
			semanticReviewScope: judgment.semanticReviewScope,
			semanticFindings: judgment.semanticFindings,
			review: "pending_author",
		});
		expect(schema.ok).toBe(result.ok || result.error.code !== "PARSE_FAILURE");
		if (!result.ok) expect(["subset_difference", "rule_finding"]).toContain(classification);
	}
});
