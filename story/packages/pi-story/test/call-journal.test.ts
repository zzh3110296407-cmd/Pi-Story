import { appendFileSync, existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { EvidenceArchive, readEvidence } from "../../../scripts/eval/p2/artifacts.ts";
import { CallSession } from "../../core/src/flow/calls.ts";
import { BranchSource } from "../src/entries.ts";
import { type CallCheckpoint, loadSettings, SessionPorts } from "../src/ports.ts";
import { createTestSession } from "./fixture.ts";

test("role inputs and actual CallRecords survive before a macro result can be persisted", async () => {
	const fixture = await createTestSession();
	try {
		const file = path.join(fixture.root, "call-checkpoints.jsonl");
		const read = (): CallCheckpoint[] =>
			existsSync(file)
				? readFileSync(file, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line))
				: [];
		const source = new BranchSource(() => fixture.manager.getBranch());
		const settings = loadSettings(fixture.agentDir);
		const abort = new AbortController();
		const services = new SessionPorts(
			source,
			() => fixture.manager.getBranch(),
			new ModelRegistry(fixture.runtime),
			settings,
			() => abort.abort(),
			(event) => appendFileSync(file, `${JSON.stringify(event)}\n`),
		);
		fixture.faux.setResponses([
			() => {
				expect(read()).toHaveLength(1);
				expect(read()[0]).toMatchObject({
					phase: "started",
					inputSources: [{ field: "canon", references: ["chapter:3", "key:char:lin"] }],
				});
				// The observer cancels after this normal provider reply reaches the adapter.
				return fauxAssistantMessage("The lighthouse lamp went out.");
			},
		]);
		const calls = new CallSession({
			model: source.model(),
			ports: services.ports,
			settings: settings.effective,
			signal: abort.signal,
		});
		const result = await calls.call("writer", "Write", '{"canon":[{"chapter":3,"key":"char:lin"}]}', {
			kind: "text",
		});
		expect(result.ok).toBe(false);
		expect(fixture.faux.state.callCount).toBe(1);
		const events = read();
		expect(events).toHaveLength(2);
		expect(events[1]).toEqual({ phase: "completed", reservationId: events[0].reservationId, record: calls.calls[0] });
		expect(calls.calls[0]).toMatchObject({ status: "reported", usage: { totalTokens: expect.any(Number) } });
		// No macro tool result exists. The independent journal already has the real record.
		expect(source.model().calls).toEqual([]);
		expect(services.guard.settledReservations()).toEqual([events[0].reservationId]);
	} finally {
		fixture.cleanup();
	}
});

test("an unfinished run retains checkpoints even when its working journal is lost", async () => {
	const fixture = await createTestSession();
	try {
		const folder = path.join(fixture.root, "public-run");
		const archive = new EvidenceArchive(folder, path.join(fixture.root, "work"), {
			suiteId: "P2-CHAP",
			runId: "offline-loss",
			expectedCaseIds: ["fiction"],
		});
		const checkpoint = {
			type: "role_checkpoint",
			phase: "started",
			caseId: "fiction",
			reservationId: "reservation-1",
			request: { role: "writer", user: "{}" },
			reservedCostUsd: 0.01,
		};
		archive.emit(checkpoint);
		unlinkSync(archive.workFile);
		const files = readdirSync(path.join(folder, "raw/role_checkpoint"));
		expect(files).toHaveLength(1);
		const saved = JSON.parse(
			gunzipSync(readFileSync(path.join(folder, "raw/role_checkpoint", files[0]))).toString("utf8"),
		);
		expect(saved).toEqual({ ...checkpoint, runId: "offline-loss" });
		expect(saved).not.toHaveProperty("record");
	} finally {
		fixture.cleanup();
	}
});

test("an unavailable pre-dispatch journal prevents the request without inventing a completed call", async () => {
	const fixture = await createTestSession();
	try {
		const source = new BranchSource(() => fixture.manager.getBranch());
		const settings = loadSettings(fixture.agentDir);
		const services = new SessionPorts(
			source,
			() => fixture.manager.getBranch(),
			new ModelRegistry(fixture.runtime),
			settings,
			undefined,
			() => {
				throw new Error("journal disk unavailable");
			},
		);
		const calls = new CallSession({ model: source.model(), ports: services.ports, settings: settings.effective });
		await expect(calls.call("writer", "Write", "{}", { kind: "text" })).rejects.toThrow("journal disk unavailable");
		expect(fixture.faux.state.callCount).toBe(0);
		expect(calls.calls).toEqual([]);
		expect(services.guard.inFlight().tokens).toBeGreaterThan(0);
	} finally {
		fixture.cleanup();
	}
});

test("repair finalization explicitly classifies an unfinished checkpoint and retains its reservation", async () => {
	const fixture = await createTestSession();
	try {
		const archive = new EvidenceArchive(
			path.join(fixture.root, "interrupted-run"),
			path.join(fixture.root, "archive"),
			{
				suiteId: "P2-CHAP",
				runId: "unfinished",
				expectedCaseIds: ["one"],
				stage: "P2R",
			},
		);
		archive.emit({
			type: "role_checkpoint",
			phase: "started",
			caseId: "one",
			reservationId: "reservation-1",
			reservedCostUsd: 0.01,
			request: { role: "writer", system: "Write", user: "{}" },
		});
		archive.finish();
		const rows = readEvidence(archive.folder, true).filter((row) => row.type === "role_checkpoint");
		expect(rows.map((row) => row.phase)).toEqual(["started", "interrupted"]);
		expect(rows[1]).toMatchObject({ classification: "interrupted", accounting: "reserved", reservedCostUsd: 0.01 });
		expect(rows[1]).not.toHaveProperty("record");
	} finally {
		fixture.cleanup();
	}
});

test("transport failure preserves a failed CallRecord and unknown usage rather than reporting zero", async () => {
	const fixture = await createTestSession();
	try {
		const events: CallCheckpoint[] = [];
		const source = new BranchSource(() => fixture.manager.getBranch());
		const settings = loadSettings(fixture.agentDir);
		const services = new SessionPorts(
			source,
			() => fixture.manager.getBranch(),
			new ModelRegistry(fixture.runtime),
			settings,
			undefined,
			(event) => events.push(event),
		);
		fixture.faux.setResponses(
			Array.from({ length: 2 }, () => () => {
				throw new Error("synthetic provider disconnect");
			}),
		);
		const calls = new CallSession({ model: source.model(), ports: services.ports, settings: settings.effective });
		expect((await calls.call("writer", "Write", "{}", { kind: "text" })).ok).toBe(false);
		expect(events).toHaveLength(4);
		expect(events[1]).toMatchObject({ phase: "completed", record: { status: "failed", usage: null } });
		expect(events[3]).toMatchObject({
			phase: "completed",
			record: { status: "failed", usage: null, retryOf: events[0].reservationId },
		});
		expect(calls.calls).toEqual(events.flatMap((event) => (event.phase === "completed" ? [event.record] : [])));
	} finally {
		fixture.cleanup();
	}
});
