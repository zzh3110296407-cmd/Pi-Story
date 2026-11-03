import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { publicEvidence } from "../p2/artifacts.ts";
import { UsageLedger } from "../p2/ledger.ts";
import { RunControl } from "../p2/run-control.ts";
import type { LocalReply } from "./faux.ts";
import { balance, provenance } from "./main.ts";
import { createMeasuredSession, type MeasuredSession } from "./session.ts";

interface Config {
	schema: "story/p3-terminal@1" | "story/p3r2-terminal@1";
	writerLengthFactor?: 0.8 | 0.9;
	runId: string;
	work: string;
	archive: string;
}
export async function createTerminalDriver(
	config: Config,
	ledger: UsageLedger,
	control: RunControl,
	fixtureReply?: LocalReply,
) {
	const v5 = config.schema === "story/p3r2-terminal@1";
	if (v5 && ![0.8, 0.9].includes(config.writerLengthFactor ?? 0)) throw new Error("V5 terminal calibration required");
	let driver: MeasuredSession | undefined;
	driver = await createMeasuredSession({
		...(v5 ? { stage: "P3R2", writerLengthFactor: config.writerLengthFactor } : {}),
		work: config.work,
		archive: config.archive,
		suiteId: v5 ? "P3R2-D" : "P3-D",
		runId: config.runId,
		caseId: "author-terminal",
		ledger,
		control,
		runLimitUsd: 2,
		main: fixtureReply ? "faux" : "real",
		internals: fixtureReply ? "faux" : "real",
		preparation: false,
		maxShowrunnerRequests: 100,
		reply:
			fixtureReply ??
			(() => {
				throw new Error("Terminal author check cannot use faux responses");
			}),
		extension: (pi) => {
			pi.on("session_shutdown", async () => {
				if (!driver) throw new Error("Terminal driver missing");
				await driver.session.abort();
				driver.emit({ type: "terminal_shutdown" });
				const text = `${JSON.stringify({ ...driver.finish(), fatal: control.fatal ?? null }, null, 2)}\n`;
				publicEvidence(text);
				writeFileSync(path.join(config.archive, "finalization.json"), text, { flag: "wx" });
			});
		},
	});
	return driver;
}

async function main(args: string[]) {
	const repository = path.resolve(import.meta.dirname, "../../../..");
	const workRoot = path.resolve(process.env.PI_STORY_WORK_DIR ?? path.join(repository, "story/testing/exec"));
	const root = path.join(repository, "story/testing/runs/P3");
	const prov = provenance(true);
	const control = new RunControl();
	const ledger = new UsageLedger(path.join(root, "usage-ledger.jsonl"), path.join(root, "request-reservations.jsonl"), {
		stopUsd: 12,
		maximumUsd: 15,
	});
	const available = await balance(control);
	if (ledger.snapshot().totalUsd >= 12) throw new Error("P3 stop threshold reached; terminal check not started");
	if (args[0] === "--prepare") {
		const runId = `${new Date()
			.toISOString()
			.replace(/[-:]/gu, "")
			.replace(/\.\d{3}Z$/u, "Z")}-${prov.commit.slice(0, 7)}-author`;
		const work = path.join(workRoot, "runs/P3-D", runId);
		mkdirSync(work, { recursive: true });
		const config: Config = { schema: "story/p3-terminal@1", runId, work, archive: path.join(root, "P3-D", runId) };
		const file = path.join(work, "terminal.json");
		writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
		console.log(JSON.stringify({ config: file, work, archive: config.archive }));
		return;
	}
	if (args[0] !== "--run" || !args[1] || !process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error("Use --prepare, then --run <config> in an interactive PowerShell terminal");
	const config = JSON.parse(readFileSync(args[1], "utf8")) as Config;
	if (
		config.schema !== "story/p3-terminal@1" ||
		path.basename(config.runId) !== config.runId ||
		path.resolve(config.work) !== path.join(workRoot, "runs/P3-D", config.runId) ||
		path.resolve(config.archive) !== path.join(root, "P3-D", config.runId)
	)
		throw new Error("Invalid terminal workspace configuration");
	process.env.PI_OFFLINE = "1";
	const driver = await createTerminalDriver(config, ledger, control);
	const manifest = JSON.stringify(
		{
			...config,
			schema: "story/p3-terminal-run@1",
			...prov,
			balance: available,
			startedAt: new Date().toISOString(),
			initialFees: ledger.snapshot(),
		},
		null,
		2,
	);
	publicEvidence(manifest);
	writeFileSync(path.join(config.archive, "manifest.json"), `${manifest}\n`, { flag: "wx" });
	await new InteractiveMode(driver.host, {
		initialMessage:
			"Write an original English mystery about Ada, a courier, and Bo, a harbor clerk, investigating a brass key in a flooded harbor. Ada must survive and nobody may be physically injured. Use third-person past tense centred on Ada. Plan three chapters of 1200 words each. Open the book and write only chapter 1 now.",
	}).run();
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
	await main(process.argv.slice(2));
