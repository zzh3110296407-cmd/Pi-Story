import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { RunControl } from "../p2/run-control.ts";
import { balance, caseWorkspace } from "../p3/main.ts";
import { createTerminalDriver } from "../p3/terminal.ts";
import { assertDeterministicGates } from "./freeze.ts";
import { isoId, stageLedger } from "./main.ts";
import { executionSource, stageRoot, writeRecord } from "./provenance.ts";

async function main(args: string[]) {
	const provenance = executionSource(true);
	if (!provenance.freeze) throw new Error("V5 freeze required");
	assertDeterministicGates(provenance.freeze.commit);
	const control = new RunControl();
	const available = await balance(control);
	const ledger = stageLedger();
	if (ledger.snapshot().totalUsd >= 6.5) throw new Error("P3R2 stop threshold reached; terminal check not started");
	if (args[0] === "--prepare") {
		const runId = `${isoId()}-${provenance.freeze.commit.slice(0, 7)}-author`;
		const work = caseWorkspace(runId, "author-terminal");
		mkdirSync(work, { recursive: true });
		const config = {
			schema: "story/p3r2-terminal@1",
			runId,
			work,
			archive: path.join(stageRoot, "P3R2-D", runId),
			writerLengthFactor: provenance.product.configuration.writerLengthFactor,
			productSha256: provenance.product.sha256,
		};
		const file = path.join(work, "terminal.json");
		writeRecord(file, config);
		console.log(JSON.stringify({ config: file, work, archive: config.archive }));
		return;
	}
	if (args[0] !== "--run" || !args[1] || !process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error("Use --prepare, then --run <config> in an interactive PowerShell terminal");
	const config = JSON.parse(readFileSync(args[1], "utf8"));
	if (
		config.schema !== "story/p3r2-terminal@1" ||
		path.basename(config.runId) !== config.runId ||
		path.resolve(config.work) !== caseWorkspace(config.runId, "author-terminal") ||
		path.resolve(config.archive) !== path.join(stageRoot, "P3R2-D", config.runId) ||
		config.writerLengthFactor !== provenance.product.configuration.writerLengthFactor ||
		config.productSha256 !== provenance.product.sha256
	)
		throw new Error("Terminal configuration differs from frozen V5 or its owned workspace");
	process.env.PI_OFFLINE = "1";
	const driver = await createTerminalDriver(config, ledger, control);
	writeRecord(path.join(config.archive, "manifest.json"), {
		...config,
		provenance,
		balance: available,
		startedAt: new Date().toISOString(),
		initialFees: ledger.snapshot(),
	});
	await new InteractiveMode(driver.host, {
		initialMessage:
			"Write an original English mystery about Ada, a courier, and Bo, a harbor clerk, investigating a brass key in a flooded harbor. Ada must survive and nobody may be physically injured. Use third-person past tense centred on Ada. Plan three chapters of 1200 words each. Open the book and write only chapter 1 now.",
	}).run();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
	await main(process.argv.slice(2));
