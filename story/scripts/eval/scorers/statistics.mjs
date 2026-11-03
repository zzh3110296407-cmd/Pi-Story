export function wilson(success, n) {
	if (!Number.isInteger(n) || n < 1 || success < 0 || success > n) return null;
	const z = 1.959963984540054;
	const p = success / n;
	const denominator = 1 + (z * z) / n;
	const center = (p + (z * z) / (2 * n)) / denominator;
	const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
	return [Math.max(0, center - half), Math.min(1, center + half)];
}
export function classification(tp, fp, fn) {
	const precision = tp + fp ? tp / (tp + fp) : null;
	const recall = tp + fn ? tp / (tp + fn) : null;
	return {
		tp,
		fp,
		fn,
		precision,
		recall,
		f1:
			precision !== null && recall !== null && precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
		precisionInterval: wilson(tp, tp + fp),
		recallInterval: wilson(tp, tp + fn),
	};
}
export function proportion(id, success, n, threshold = 1, extra = {}) {
	return {
		id,
		n,
		value: n ? success / n : null,
		confidence95: wilson(success, n),
		threshold,
		type: "gate",
		passed: n > 0 && success / n >= threshold,
		judgment: "program",
		records: ["raw/vitest.json", "raw/observations.jsonl"],
		...extra,
	};
}
export function median(values) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
