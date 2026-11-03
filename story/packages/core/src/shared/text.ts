import { createHash } from "node:crypto";

export const normalizeLines = (text: string): string => text.replace(/\r\n?/gu, "\n");
export const chapterId = (chapter: number): string => {
	if (!Number.isInteger(chapter) || chapter < 1) throw new RangeError("Invalid chapter number");
	return `c${String(chapter).padStart(2, "0")}`;
};
export const digest = (text: string): string =>
	createHash("sha256").update(normalizeLines(text), "utf8").digest("hex").slice(0, 16);

const slug = "[a-z0-9_]+";
const positive = "0*[1-9][0-9]*";
const ids = new RegExp(
	`^(?:c${positive}-(?:d${positive}|[pr]${positive}(?:-o${positive})?)|c${positive}\\.s${positive}|[LFSKHX]-[1-9][0-9]*|(?:char|place|rule|line|fw|item|org):${slug}|rel:${slug}->${slug})$`,
	"u",
);
export const validId = (id: string): boolean => ids.test(id);
export const numberedLines = (text: string): { n: number; text: string }[] =>
	normalizeLines(text)
		.split("\n")
		.map((text, index) => ({ n: index + 1, text }));

export interface Sentence {
	id: string;
	text: string;
	start: number;
	end: number;
}
const closers = /[”」』"'’）)\]]/u;

function afterClosers(text: string, offset: number, markdown = false): number {
	while (offset < text.length) {
		if (closers.test(text[offset])) {
			const closer = text[offset++];
			// Adjacent straight quotes close one speaker and open the next.
			if ((closer === '"' || closer === "'") && text[offset] === closer) break;
		} else if (markdown && /[*_]/u.test(text[offset])) {
			const marker = text[offset].repeat(text[offset + 1] === text[offset] ? 2 : 1);
			const prefix = text.slice(text.lastIndexOf("\n", offset - 1) + 1, offset);
			if ((prefix.split(marker).length - 1) % 2 !== 1) break;
			offset += marker.length;
		} else break;
	}
	return offset;
}

// s1 remains frozen; s2 adds the author-approved editorial rules in ADR-014.
// Both index the LF-normalized body in UTF-16 code units.
export function sentences(body: string, chapter: number, rule = "s1"): Sentence[] {
	if (rule !== "s1" && rule !== "s2") throw new RangeError(`Unsupported sentence rule: ${rule}`);
	const rich = rule === "s2";
	const text = normalizeLines(body);
	const result: Sentence[] = [];
	let start = 0;
	const emit = (end: number) => {
		const fragment = text.slice(start, end);
		const trimmed = fragment.trim();
		if (trimmed) {
			const offset = start + fragment.indexOf(trimmed);
			result.push({
				id: `${chapterId(chapter)}.s${String(result.length + 1).padStart(4, "0")}`,
				text: trimmed,
				start: offset,
				end: offset + trimmed.length,
			});
		}
		start = end;
	};
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === "\n") {
			emit(i);
			start = i + 1;
			continue;
		}
		let end = i + 1;
		let boundary = /[。！？]/u.test(char);
		if (boundary) while (/[。！？]/u.test(text[end] ?? "")) end++;
		if (char === "…" && text[i + 1] === "…") {
			while (text[end] === "…") end++;
			boundary = end === text.length || text[end] === "\n" || closers.test(text[end]);
		}
		if (/[.!?]/u.test(char)) {
			while (/[.!?]/u.test(text[end] ?? "")) end++;
			const after = afterClosers(text, end, rich);
			boundary = after === text.length || /\s/u.test(text[after]);
			if (char === ".") {
				const prefix = text.slice(start, i + 1);
				if (
					/\b(?:Mr|Mrs|Dr|St|e\.g|i\.e|etc)\.$/iu.test(prefix) ||
					/\b[A-Z]\.$/u.test(prefix) ||
					(/\d/u.test(text[i - 1] ?? "") && /\d/u.test(text[i + 1] ?? ""))
				)
					boundary = false;
				if (rich) {
					const tail = text.slice(after).trimStart();
					const linePrefix = text.slice(start, i + 1);
					if (
						(/\b[ap]\.m\.$/iu.test(prefix) && /^[a-z\d]/u.test(tail)) ||
						/\b(?:migr|decom)\.$/iu.test(prefix) ||
						/^\s*(?:>\s*)?[*_]{0,2}\d+\.$/u.test(linePrefix)
					)
						boundary = false;
				}
			}
		}
		if (boundary) {
			end = afterClosers(text, end, rich);
			emit(end);
			i = end - 1;
		}
	}
	emit(text.length);
	return result;
}

export function wordCount(text: string): { unit: "zh_chars" | "en_words"; value: number } {
	const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
	const words = text.replace(/\p{Script=Han}/gu, " ").match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
	return { unit: han ? "zh_chars" : "en_words", value: han + words };
}

// E3/E6: deterministic LCS, ties consume the old line first. Returns target line numbers.
export function changedLines(before: string, after: string): number[] {
	const a = normalizeLines(before).split("\n");
	const b = normalizeLines(after).split("\n");
	const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
	for (let i = a.length - 1; i >= 0; i--)
		for (let j = b.length - 1; j >= 0; j--)
			table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
	const changed: number[] = [];
	let i = 0;
	let j = 0;
	while (j < b.length) {
		if (i < a.length && a[i] === b[j]) {
			i++;
			j++;
		} else if (i < a.length && table[i + 1][j] >= table[i][j + 1]) i++;
		else {
			changed.push(j + 1);
			j++;
		}
	}
	return changed;
}

export const normalizeQuote = (text: string): string =>
	text
		.normalize("NFC")
		.replace(/[\uFF01-\uFF5E]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
		.replace(/\s+/gu, " ")
		.trim();
export interface SourceSpan {
	messageId: string;
	quote: string;
	start: number;
	end: number;
}
// C2: offsets index the NFC / fullwidth-ASCII / whitespace-normalized message.
export function locateQuote(messages: readonly { entryId: string; text: string }[], quote: string): SourceSpan | null {
	const normalized = normalizeQuote(quote);
	if (!normalized) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		const start = normalizeQuote(message.text).indexOf(normalized);
		if (start >= 0) return { messageId: message.entryId, quote, start, end: start + normalized.length };
	}
	return null;
}

// D3: quotes must be paired within one paragraph; nested quotations are supported.
export function inDialogue(body: string, sentence: Pick<Sentence, "start" | "end">): boolean {
	const text = normalizeLines(body);
	const stack: { close: string; start: number }[] = [];
	const pairs: Record<string, string> = { "“": "”", "「": "」", "『": "』", '"': '"' };
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === "\n") {
			stack.length = 0;
			continue;
		}
		if (char === stack.at(-1)?.close) {
			const open = stack.pop();
			if (open && sentence.start >= open.start && sentence.end <= i + 1) return true;
		} else if (pairs[char]) stack.push({ start: i, close: pairs[char] });
	}
	return false;
}
