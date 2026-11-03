import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { BranchSource } from "../src/entries.ts";
import { createTestSession, draftText, keeperReply } from "./fixture.ts";
import { p3Opening } from "./p3-fixture.ts";

async function open(f: Awaited<ReturnType<typeof createTestSession>>, chapters = 2) {
	f.faux.setResponses([
		fauxAssistantMessage(p3Opening(chapters), { stopReason: "toolUse" }),
		fauxAssistantMessage("Book open."),
	]);
	await f.session.prompt("Ada must survive.");
	await f.session.prompt(`/goal ${chapters}`);
}

test("F1 followUp becomes native author input before the next chapter decision", async () => {
	const note = "In the next chapter Ada must examine the yellow buoy.";
	const writers: string[] = [];
	const f = await createTestSession({
		observe: ({ request }) => {
			if (request.role === "writer") writers.push(request.user);
		},
	});
	try {
		await open(f);
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write_next_chapter", {}), { stopReason: "toolUse" }),
			async () => {
				await f.session.followUp(note);
				return fauxAssistantMessage(draftText);
			},
			fauxAssistantMessage('{"observations":[]}'),
			fauxAssistantMessage(JSON.stringify(keeperReply)),
			(context) => {
				const seen = context.messages.some(
					(message) => message.role === "user" && JSON.stringify(message).includes(note),
				);
				return fauxAssistantMessage(
					[
						{ type: "text", text: "Chapter one committed." },
						fauxToolCall("write_next_chapter", { brief: seen ? note : "" }),
					],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage(draftText),
			fauxAssistantMessage('{"observations":[]}'),
			fauxAssistantMessage(JSON.stringify(keeperReply)),
			fauxAssistantMessage("Both chapters committed."),
			fauxAssistantMessage("Received the queued message."),
		]);
		await f.session.prompt("Write two chapters.");
		const model = new BranchSource(() => f.manager.getBranch()).model();
		expect(model.commits).toHaveLength(2);
		expect(writers).toHaveLength(2);
		expect(writers[0]).not.toContain(note);
		expect(writers[1]).toContain(note);
		expect(f.story?.current()?.gate.sequence).toBe(0);
		const messages = f.session.messages;
		const native = messages.findIndex((message) => message.role === "user" && JSON.stringify(message).includes(note));
		const nextWrite = messages.findLastIndex(
			(message) =>
				message.role === "assistant" &&
				message.content.some((block) => block.type === "toolCall" && block.name === "write_next_chapter"),
		);
		expect(native).toBeGreaterThan(0);
		expect(native).toBeLessThan(nextWrite);
		expect(f.errors).toEqual([]);
	} finally {
		f.cleanup();
	}
});

test("F2 followUp arriving between chapters defers the tool without a core attempt", async () => {
	const note = "Ada should inspect the northern jetty next.";
	let writers = 0;
	const f = await createTestSession({
		observe: ({ request }) => {
			if (request.role === "writer") writers++;
		},
	});
	try {
		await open(f);
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write_next_chapter", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(draftText),
			fauxAssistantMessage('{"observations":[]}'),
			fauxAssistantMessage(JSON.stringify(keeperReply)),
			async () => {
				await f.session.followUp(note);
				return fauxAssistantMessage(fauxToolCall("write_next_chapter", {}), { stopReason: "toolUse" });
			},
			(context) => {
				expect(writers).toBe(1);
				expect(
					context.messages.some((message) => message.role === "user" && JSON.stringify(message).includes(note)),
				).toBe(true);
				return fauxAssistantMessage(fauxToolCall("write_next_chapter", { brief: note }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage(draftText),
			fauxAssistantMessage('{"observations":[]}'),
			fauxAssistantMessage(JSON.stringify(keeperReply)),
			fauxAssistantMessage("Done."),
		]);
		await f.session.prompt("Write the next chapters.");
		const results = f.session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "write_next_chapter",
		);
		expect(results).toHaveLength(3);
		expect(results[1]).toMatchObject({ details: { schema: "story/host-deferred@1", code: "AUTHOR_MESSAGE_PENDING" } });
		expect(results[1]).not.toMatchObject({ isError: true });
		const model = new BranchSource(() => f.manager.getBranch()).model();
		expect(model.commits).toHaveLength(2);
		expect(Object.values(model.failures).every((failures) => failures === 0)).toBe(true);
		expect(writers).toBe(2);
		expect(f.story?.current()?.gate.sequence).toBe(0);
		expect(f.errors).toEqual([]);
	} finally {
		f.cleanup();
	}
});

test("F3 consecutive followUps preserve text, image and native message order", async () => {
	const notes = ["Next, Ada studies the numbered buoy.", "Then she photographs the tide mark."];
	const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
	const writers: string[] = [];
	const f = await createTestSession({
		observe: ({ request }) => {
			if (request.role === "writer") writers.push(request.user);
		},
	});
	try {
		await open(f, 2);
		let received = false;
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write_next_chapter", {}), { stopReason: "toolUse" }),
			async () => {
				await f.session.followUp(notes[0], [image]);
				await f.session.followUp(notes[1]);
				return fauxAssistantMessage(draftText);
			},
			fauxAssistantMessage('{"observations":[]}'),
			fauxAssistantMessage(JSON.stringify(keeperReply)),
			// Pi's default steering queue releases one message per turn. The second
			// note must therefore defer this attempted write until it too is native.
			fauxAssistantMessage(fauxToolCall("write_next_chapter", {}), { stopReason: "toolUse" }),
			(context) => {
				const user = context.messages.filter(
					(message) => message.role === "user" && notes.some((note) => JSON.stringify(message).includes(note)),
				);
				expect(user).toHaveLength(2);
				expect(JSON.stringify(user[0])).toContain(notes[0]);
				expect(JSON.stringify(user[0])).toContain(image.data);
				expect(JSON.stringify(user[1])).toContain(notes[1]);
				received = true;
				return fauxAssistantMessage(fauxToolCall("write_next_chapter", { brief: notes.join("\n") }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(draftText),
			fauxAssistantMessage('{"observations":[]}'),
			fauxAssistantMessage(JSON.stringify(keeperReply)),
			fauxAssistantMessage("Both chapters committed."),
		]);
		await f.session.prompt("Write one chapter.");
		expect(
			received,
			JSON.stringify(
				f.session.messages.filter((message) => message.role === "assistant" && message.stopReason === "error"),
			),
		).toBe(true);
		expect(f.story?.current()?.followUps.hasPending).toBe(false);
		expect(writers).toHaveLength(2);
		for (const note of notes) {
			expect(writers[0]).not.toContain(note);
			expect(writers[1]).toContain(note);
		}
		expect(f.story?.current()?.gate.sequence).toBe(0);
		expect(f.errors).toEqual([]);
	} finally {
		f.cleanup();
	}
});

test("F6 settlement flushes a between-chapter followUp before automatic continuation", async () => {
	const note = "Inspect the clock on the pier next.";
	const f = await createTestSession({ observe: () => {} });
	try {
		await open(f, 1);
		let seen = false;
		f.faux.setResponses([
			async () => {
				await f.session.followUp(note);
				return fauxAssistantMessage("Preparing the next chapter.");
			},
			(context) => {
				seen = context.messages.some((message) => message.role === "user" && JSON.stringify(message).includes(note));
				return fauxAssistantMessage(fauxToolCall("write_next_chapter", { brief: note }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage(draftText),
			fauxAssistantMessage('{"observations":[]}'),
			fauxAssistantMessage(JSON.stringify(keeperReply)),
			fauxAssistantMessage("Done."),
		]);
		await f.session.prompt("Write one chapter.");
		expect(seen).toBe(true);
		expect(new BranchSource(() => f.manager.getBranch()).model().commits).toHaveLength(1);
		expect(f.errors).toEqual([]);
	} finally {
		f.cleanup();
	}
});

test("F4 idle followUp remains an ordinary native author prompt", async () => {
	const f = await createTestSession({ observe: () => {} });
	try {
		f.faux.setResponses([fauxAssistantMessage("Ready.")]);
		await f.session.prompt("Ada must survive.", { streamingBehavior: "followUp" });
		expect(
			f.session.messages.some(
				(message) => message.role === "user" && JSON.stringify(message).includes("Ada must survive."),
			),
		).toBe(true);
		expect(f.story?.current()?.followUps.hasPending).toBe(false);
		expect(f.errors).toEqual([]);
	} finally {
		f.cleanup();
	}
});

test("F6 pending input at goal completion reaches the next main decision", async () => {
	const note = "Before ending, report the clue Ada found.";
	const f = await createTestSession();
	try {
		await open(f, 1);
		let seen = false;
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write_next_chapter", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(draftText),
			fauxAssistantMessage('{"observations":[]}'),
			async () => {
				await f.session.followUp(note);
				return fauxAssistantMessage(JSON.stringify(keeperReply));
			},
			(context) => {
				seen = context.messages.some((message) => message.role === "user" && JSON.stringify(message).includes(note));
				return fauxAssistantMessage("Ada found the brass key. The one-chapter goal is complete.");
			},
		]);
		await f.session.prompt("Write one chapter.");
		expect(seen).toBe(true);
		expect(new BranchSource(() => f.manager.getBranch()).model().commits).toHaveLength(1);
		expect(f.errors).toEqual([]);
	} finally {
		f.cleanup();
	}
});

test("F7 abort returns undelivered text and image without starting another request", async () => {
	const note = "Next chapter: use the photograph of the broken lighthouse.";
	const image = { type: "image" as const, data: "cGhvdG8=", mimeType: "image/png" };
	const f = await createTestSession({ observe: () => {} });
	try {
		await open(f, 1);
		let requests = 0;
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write_next_chapter", {}), { stopReason: "toolUse" }),
			async () => {
				requests++;
				await f.session.followUp(note, [image]);
				void f.session.abort();
				return fauxAssistantMessage(draftText);
			},
			() => {
				requests++;
				return fauxAssistantMessage("Must not run.");
			},
		]);
		await f.session.prompt("Write one chapter.");
		const returned = f.manager
			.getBranch()
			.find((entry) => entry.type === "custom_message" && entry.customType === "story.pending-author-input");
		expect(JSON.stringify(returned)).toContain(note);
		expect(JSON.stringify(returned)).toContain(image.data);
		expect(returned).toMatchObject({ display: true });
		expect(requests).toBe(1);
		expect(f.story?.current()?.followUps.hasPending).toBe(false);
		expect(new BranchSource(() => f.manager.getBranch()).model().commits).toHaveLength(0);
		expect(f.errors).toEqual([]);
	} finally {
		f.cleanup();
	}
});
