import { expect, test } from "vitest";
import { calibrateInput, chooseFactor, lengthSummary } from "../../../scripts/eval/p3r2/writer-length.ts";

test("S3 calibration changes only the numeric writer budget and leaves the original target intact", () => {
	const original = {
		task: "draft",
		targetWords: 1351,
		wordRange: { min: 1148, max: 1554 },
		intent: { brief: "Keep the key." },
		ledger: [{ text: "No injuries." }],
	};
	const input = calibrateInput(original, 0.8);
	const shown = Math.round(1351 * 0.8);
	const { targetWords, wordRange, ...rest } = input;
	const { targetWords: _originalTarget, wordRange: _originalRange, ...expected } = original;
	expect(targetWords).toBe(shown);
	expect(wordRange).toEqual({ min: Math.round(shown * 0.85), max: Math.round(shown * 1.15) });
	expect(rest).toEqual(expected);
	expect(original.targetWords).toBe(1351);
});

test("S3 selection uses original T, requires 85% and at most one short chapter, and prefers 0.9 if both qualify", () => {
	const good = Array.from({ length: 20 }, () => ({ words: 1000, target: 1000, complete: true }));
	const a = lengthSummary(good);
	const b = lengthSummary([
		...good.slice(0, 18),
		{ words: 1400, target: 1000, complete: true },
		{ words: 650, target: 1000, complete: true },
	]);
	expect(chooseFactor(a, b)).toBe(0.9);
	const twoShort = lengthSummary([
		...good.slice(0, 18),
		...Array.from({ length: 2 }, () => ({ words: 650, target: 1000, complete: true })),
	]);
	expect(chooseFactor(a, twoShort)).toBe(0.8);
	expect(chooseFactor(twoShort, twoShort)).toBeNull();
	expect(lengthSummary(good.map((row, i) => ({ ...row, complete: i !== 0 }))).complete).toBe(false);
	expect(chooseFactor(lengthSummary(good.slice(0, 14)), a)).toBeNull();
});

test("S3 percentage ranges retain the existing exact half-word rounding contract", () => {
	expect(calibrateInput({ targetWords: 1500 }, 0.9)).toMatchObject({
		targetWords: 1350,
		wordRange: { min: 1148, max: 1553 },
	});
	expect(calibrateInput({ targetWords: 100 }, 0.9)).toMatchObject({
		targetWords: 90,
		wordRange: { min: 77, max: 104 },
	});
});
