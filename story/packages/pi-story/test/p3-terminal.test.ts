import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { readEvidence } from "../../../scripts/eval/p2/artifacts.ts";
import { UsageLedger } from "../../../scripts/eval/p2/ledger.ts";
import { RunControl } from "../../../scripts/eval/p2/run-control.ts";
import { createTerminalDriver } from "../../../scripts/eval/p3/terminal.ts";

test.each(["story/p3-terminal@1", "story/p3r2-terminal@1"] as const)(
	"%s shutdown archives native evidence and the actual stage before host disposal",
	async (schema) => {
		const work = process.env.PI_STORY_WORK_DIR;
		if (!work) throw new Error("Project workspace required");
		mkdirSync(path.join(work, "temp"), { recursive: true });
		const root = mkdtempSync(path.join(work, "temp/p3-terminal-"));
		const config = {
			schema,
			...(schema === "story/p3r2-terminal@1" ? { writerLengthFactor: 0.9 as const } : {}),
			runId: "offline-terminal",
			work: path.join(root, "work"),
			archive: path.join(root, "archive"),
		};
		const driver = await createTerminalDriver(
			config,
			new UsageLedger(path.join(root, "fees.jsonl"), path.join(root, "reserves.jsonl")),
			new RunControl(),
			() => fauxAssistantMessage("Ready."),
		);
		try {
			await driver.session.bindExtensions({
				mode: "print",
				onError: () => {
					throw new Error("Extension error");
				},
			});
			await driver.session.prompt("Prepare a book.");
			expect(driver.story.current()?.settings.effective.writerLengthFactor).toBe(
				schema === "story/p3r2-terminal@1" ? 0.9 : undefined,
			);
			await driver.host.dispose();
			const final = JSON.parse(readFileSync(path.join(config.archive, "finalization.json"), "utf8")) as {
				fee: { requests: number };
			};
			expect(final.fee.requests).toBe(0);
			expect(readEvidence(config.archive).some((row) => row.type === "terminal_shutdown")).toBe(true);
			expect(readEvidence(config.archive).find((row) => row.type === "meta")?.stage).toBe(
				schema === "story/p3r2-terminal@1" ? "P3R2" : "P3",
			);
		} finally {
			driver.dispose();
		}
	},
);
