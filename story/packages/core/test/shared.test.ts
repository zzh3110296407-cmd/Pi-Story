import { describe, expect, test } from "vitest";
import {
	changedLines,
	chapterId,
	digest,
	inDialogue,
	locateQuote,
	numberedLines,
	sentences,
	validId,
	wordCount,
} from "../src/shared/text.ts";

describe("s1 fixed sentence rule", () => {
	for (const [input, expected] of [
		["他说：“走吧？！ ”\r\n下一段。再见！", ["他说：“走吧？！", "”", "下一段。", "再见！"]],
		["“你好！”她说。", ["“你好！”", "她说。"]],
		["Mr. Smith paid 3.14. Dr. A. Li left! Next? Yes.", ["Mr. Smith paid 3.14.", "Dr. A. Li left!", "Next?", "Yes."]],
		["Use e.g. a pen, i.e. ink etc. today. Done.", ["Use e.g. a pen, i.e. ink etc. today.", "Done."]],
		["“等等……”她说：『去「那里」！』", ["“等等……”", "她说：『去「那里」！』"]],
		["One (yes!). Two.\n\nNo punctuation", ["One (yes!).", "Two.", "No punctuation"]],
		["中文……还有话。末尾……", ["中文……还有话。", "末尾……"]],
		['"你好！""再见。"', ['"你好！"', '"再见。"']],
	] as const) {
		test(input, () => {
			const result = sentences(input, 3);
			expect(result.map((item) => item.text)).toEqual(expected);
			expect(sentences(input, 3)).toEqual(result);
			expect(result.map((item) => item.id)).toEqual(expected.map((_, i) => `c03.s${String(i + 1).padStart(4, "0")}`));
		});
	}
});

test("IDs: canonical formats and rejection", () => {
	expect(chapterId(3)).toBe("c03");
	for (const value of [
		"c03-d02",
		"c03-p01",
		"c03-r01-o04",
		"c03-p01-o02",
		"c03.s0042",
		"L-1",
		"F-12",
		"S-3",
		"K-7",
		"H-4",
		"X-2",
		"char:lin_yu",
		"rel:a->b",
	])
		expect(validId(value)).toBe(true);
	for (const value of ["c00-d01", "F-0", "char:Upper", "rel:a-b", "c03-r00", "unknown:a"])
		expect(validId(value)).toBe(false);
});
test("digest/lines: normalize CRLF and CR; UTF-8 SHA256 prefix", () => {
	expect(digest("abc")).toBe("ba7816bf8f01cfea");
	expect(digest("甲\r\n乙\r丙")).toBe(digest("甲\n乙\n丙"));
	expect(numberedLines("a\r\nb\r")).toEqual([
		{ n: 1, text: "a" },
		{ n: 2, text: "b" },
		{ n: 3, text: "" },
	]);
	expect(wordCount("Hello, world! 你好")).toEqual({ unit: "zh_chars", value: 4 });
	expect(wordCount("Don't leave.")).toEqual({ unit: "en_words", value: 2 });
	expect(wordCount("Hello你好world")).toEqual({ unit: "zh_chars", value: 4 });
});
test("LCS: changed target lines, deletions, ties deterministic", () => {
	expect(changedLines("a\nb\nc", "a\nx\nc\nd")).toEqual([2, 4]);
	expect(changedLines("a\nb\nc", "a\nc")).toEqual([]);
	expect(changedLines("a\nb\na", "a\na\nb")).toEqual([3]);
	expect(changedLines("a", "a")).toEqual([]);
});
test("C2: quote matching NFC, whitespace, nearest message and absent quote", () => {
	const messages = [
		{ entryId: "old", text: "café   是主角" },
		{ entryId: "new", text: "cafe\u0301\n是主角。" },
	];
	expect(locateQuote(messages, "café 是主角")).toEqual({ messageId: "new", quote: "café 是主角", start: 0, end: 8 });
	expect(locateQuote(messages, "反派")).toBeNull();
	expect(locateQuote(messages, "   ")).toBeNull();
});
test("D3: paired nested dialogue, narrative and unclosed quotes", () => {
	const text = "他想了想。\n“我说『你好。』明白吗？”\n事实。";
	const parts = sentences(text, 1);
	expect(parts.map((part) => inDialogue(text, part))).toEqual([false, true, true, false]);
	expect(inDialogue("“未闭合。", sentences("“未闭合。", 1)[0])).toBe(false);
});
