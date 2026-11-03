import { classification, median, proportion, wilson } from "./statistics.mjs";

export function scoreSuite(suite, report, observations) {
	const rows = (kind) => observations.filter((item) => item.kind === kind).map((item) => item.data);
	const observed = (id, n, value, extra = {}) => ({
		id,
		n,
		value,
		confidence95: null,
		threshold: null,
		type: "observation",
		passed: null,
		judgment: "program",
		records: ["raw/observations.jsonl"],
		...extra,
	});
	if (suite === "P1-UNIT") return [proportion("H02", report.numPassedTests, report.numTotalTests)];
	if (suite === "P1-S0") {
		const data = rows("boundaries");
		return [
			proportion(
				"H13",
				data.reduce((n, item) => n + (item.skipped || item.exitCode !== 0 ? 0 : item.passed), 0),
				data.reduce((n, item) => n + item.negative, 0),
			),
		];
	}
	if (suite === "P1-COV") {
		const data = rows("coverage")[0];
		return [
			proportion("H01", data?.covered ?? 0, data?.total ?? 0, 1, {
				exemptions: data?.exemptions ?? [],
				missing: data?.missing ?? [],
			}),
		];
	}
	if (suite === "P1-SEG") {
		const data = rows("segmentation").filter((item) => item.split === "acceptance");
		const measure = (items) => {
			let tp = 0;
			let fp = 0;
			let fn = 0;
			for (const item of items) {
				const gold = new Set(item.gold);
				const predicted = new Set(item.predicted);
				tp += [...predicted].filter((value) => gold.has(value)).length;
				fp += [...predicted].filter((value) => !gold.has(value)).length;
				fn += [...gold].filter((value) => !predicted.has(value)).length;
			}
			return { n: tp + fn, ...classification(tp, fp, fn) };
		};
		const languages = Object.fromEntries(
			["zh", "en"].map((language) => [language, measure(data.filter((item) => item.language === language))]),
		);
		const strata = Object.fromEntries(
			[...new Set(data.map((item) => `${item.language}/${item.category}`))].map((key) => [
				key,
				measure(data.filter((item) => `${item.language}/${item.category}` === key)),
			]),
		);
		const naturalChinese = measure(data.filter((item) => item.language === "zh" && item.category === "natural_prose"));
		return [
			{
				...observed("H04", data.length, languages),
				type: "gate",
				threshold: { f1: 0.98, minimumSentencesPerLanguage: 300, minimumNaturalChineseSentences: 300 },
				strata,
				naturalChinese,
				passed:
					Object.values(languages).every((item) => item.n >= 300 && item.f1 >= 0.98) &&
					naturalChinese.n >= 300 &&
					naturalChinese.f1 >= 0.98,
			},
			observed("P1-O3", data.length, rows("segmentation-observation")),
		];
	}
	if (suite === "P1-QUOTE") {
		const all = rows("quote");
		const data = all.filter((item) => typeof item.expected === "boolean");
		const positive = data.filter((item) => item.expected);
		const negative = data.filter((item) => !item.expected);
		const falseAccepts = negative.filter((item) => item.actual);
		const falseRejects = positive.filter((item) => !item.actual);
		return [
			{
				...observed("H05", all.length, {
					falseAccepts: falseAccepts.length,
					negatives: negative.length,
					falseAcceptRate: negative.length ? falseAccepts.length / negative.length : null,
					falseRejects: falseRejects.length,
					positives: positive.length,
					falseRejectRate: positive.length ? falseRejects.length / positive.length : null,
				}),
				confidence95: {
					falseAcceptRate: wilson(falseAccepts.length, negative.length),
					falseRejectRate: wilson(falseRejects.length, positive.length),
				},
				threshold: { falseAcceptRate: 0, falseRejectRate: 0.1, minimumCases: 60 },
				type: "gate",
				passed:
					all.length >= 60 &&
					negative.length > 0 &&
					positive.length > 0 &&
					falseAccepts.length === 0 &&
					falseRejects.length / positive.length <= 0.1,
				falseRejectIds: falseRejects.map((item) => item.id),
				uncertainIds: all.filter((item) => item.expected === "uncertain").map((item) => item.id),
				labelReview: "pending_author",
			},
		];
	}
	if (suite === "P1-DELTA") {
		const data = rows("delta");
		const valid = data.filter((item) => item.group === "valid");
		const invalid = data.filter((item) => item.group === "violation");
		const rules = {};
		for (let i = 1; i <= 11; i++) {
			const cases = invalid.filter((item) => item.rule === `D${i}`);
			rules[`D${i}`] = { n: cases.length, matched: cases.filter((item) => item.matched).length };
		}
		return [
			{
				...proportion("H06", data.filter((item) => item.matched).length, data.length),
				value: {
					valid: { n: valid.length, falseRejects: valid.filter((item) => !item.matched).length },
					violations: { n: invalid.length, detected: invalid.filter((item) => item.matched).length },
					rules,
				},
				passed:
					valid.length >= 20 &&
					valid.every((item) => item.matched) &&
					Object.values(rules).every((item) => item.n >= 3 && item.matched === item.n),
			},
		];
	}
	if (suite === "P1-FLOW") {
		const data = rows("flow");
		return [
			proportion("H07", data.filter((item) => item.matched).length, data.length, 1, {
				scenarioIds: data.map((item) => item.id),
			}),
		];
	}
	if (suite === "P1-CHECK") {
		const data = rows("program-check");
		const byRule = {};
		for (const kind of ["too_short", "length", "marker", "duplicate"]) {
			const cases = data.filter((item) => item.target === kind);
			byRule[kind] = {
				positive: cases.filter((item) => item.expected).length,
				negative: cases.filter((item) => !item.expected).length,
				...classification(
					cases.filter((item) => item.expected && item.detected).length,
					cases.filter((item) => !item.expected && item.detected).length,
					cases.filter((item) => item.expected && !item.detected).length,
				),
			};
		}
		return [
			{
				...observed("H08", data.length, byRule),
				type: "gate",
				threshold: { precision: 1, recall: 1, eachPositive: 5, eachNegative: 5 },
				passed: Object.values(byRule).every(
					(item) => item.positive >= 5 && item.negative >= 5 && item.precision === 1 && item.recall === 1,
				),
			},
			observed("P1-O2", rows("real-check").length, rows("real-check")),
		];
	}
	if (suite === "P1-EST") {
		const data = rows("estimate");
		const underestimated = data.filter((item) => item.estimated < item.actual).length;
		const ratios = data.map((item) => item.estimated / item.actual);
		return [
			{
				...observed("H09", data.length, underestimated),
				type: "gate",
				threshold: 0,
				passed: data.length >= 20 && underestimated === 0,
			},
			observed("H09-O", data.length, { median: median(ratios), max: ratios.length ? Math.max(...ratios) : null }),
		];
	}
	if (suite === "P1-FOLD") {
		const data = rows("determinism");
		const perf = rows("performance")[0];
		// Compare raw medians with the threshold; rounded seconds are presentation only.
		const elapsed = (values) =>
			values?.length === 5 && values.every((value) => Number.isFinite(value) && value >= 0)
				? median(values) / 1000
				: null;
		const full = elapsed(perf?.fullMs);
		const incremental = elapsed(perf?.incrementalMs);
		return [
			proportion("H03", data.filter((item) => item.hash1 === item.hash2).length, data.length),
			{
				...observed("H14", perf?.fullMs?.length ?? 0, full),
				type: "gate",
				threshold: 1,
				passed: full !== null && full <= 1,
				displayValue: full === null ? null : Math.ceil(full * 10) / 10,
				comparison: "threshold",
			},
			observed("H14-O", perf?.incrementalMs?.length ?? 0, incremental, {
				displayValue: incremental === null ? null : Math.ceil(incremental * 10) / 10,
				comparison: "observation_only",
			}),
		];
	}
	if (suite === "P1-REPLAY") {
		const data = rows("replay");
		const rejected = data.filter((item) => !item.schemaOk || !item.domainOk);
		const judgmentMatches = data.filter((item) => item.classification === item.expectedClassification).length;
		return [
			{
				...observed("P1-O1", data.length, {
					schemaPassed: data.filter((item) => item.schemaOk).length,
					domainPassed: data.filter((item) => item.domainOk).length,
					judgmentMatches,
					semanticFindingIds: data.filter((item) => item.semanticFindings?.length).map((item) => item.id),
					correctionReferenceCount: rows("replay-correction").length,
					rejected: rejected.length,
					classifications: {
						subsetDifference: rejected.filter((item) => item.classification === "subset_difference").length,
						ruleFinding: rejected.filter((item) => item.classification === "rule_finding").length,
					},
					unclassified: rejected.filter((item) => !["subset_difference", "rule_finding"].includes(item.classification))
						.length,
				}),
				classificationGatePassed:
					data.length === 37 &&
					judgmentMatches === data.length &&
					rejected.every((item) => ["subset_difference", "rule_finding"].includes(item.classification)),
			},
		];
	}
	throw new Error(`Unregistered scorer: ${suite}`);
}

export function compareSuiteMetrics(reference, rerun) {
	const differences = [];
	const timings = [];
	if (reference.suiteId !== rerun.suiteId) differences.push("suiteId");
	if (!reference.metrics.length || !rerun.metrics.length) differences.push("metrics");
	const ids = new Set([...reference.metrics, ...rerun.metrics].map((item) => item.id));
	for (const id of ids) {
		const left = reference.metrics.filter((item) => item.id === id);
		const right = rerun.metrics.filter((item) => item.id === id);
		if (left.length !== 1 || right.length !== 1) {
			differences.push(id);
			continue;
		}
		const a = left[0],
			b = right[0];
		if (reference.suiteId === "P1-FOLD" && ["H14", "H14-O"].includes(id)) {
			const stable = ({ value: _value, displayValue: _display, ...rest }) => rest;
			if (
				JSON.stringify(stable(a)) !== JSON.stringify(stable(b)) ||
				![a, b].every((item) => Number.isFinite(item.value) && item.value >= 0 && item.n === 5) ||
				(id === "H14" && ![a, b].every((item) => item.passed === true && item.value <= 1 && item.threshold === 1))
			)
				differences.push(id);
			timings.push({
				id,
				reference: a.value,
				rerun: b.value,
				policy: id === "H14" ? "both_at_most_1_second" : "observation_only",
			});
		} else if (JSON.stringify(a) !== JSON.stringify(b)) differences.push(id);
	}
	return { equal: differences.length === 0, differences, timings };
}
