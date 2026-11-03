import path from "node:path";
import { expect, test } from "vitest";
import { P3RpcClient } from "../../../scripts/eval/p3/rpc.ts";

const cli = path.resolve(import.meta.dirname, "fixtures/p3-rpc-child.mjs");

test("a handled long-running command needs a command deadline covering its full work, not only a settle deadline", async () => {
	const short = new P3RpcClient({ cli, cwd: path.dirname(cli), commandTimeoutMs: 30, settleTimeoutMs: 1000 });
	try {
		await expect(short.promptAndWait("handled-late")).rejects.toThrow("command timed out");
	} finally {
		await short.close();
	}
	const long = new P3RpcClient({ cli, cwd: path.dirname(cli), commandTimeoutMs: 1000, settleTimeoutMs: 1000 });
	try {
		expect(await long.promptAndWait("handled-late")).toMatchObject({ disposition: "handled" });
	} finally {
		await long.close();
	}
});
test("P3 RPC forwards an editor response and distinguishes steer/followUp without losing early settled events", async () => {
	const events: Record<string, unknown>[] = [];
	const client = new P3RpcClient({
		cli,
		cwd: path.dirname(cli),
		onEvent: (event) => events.push(event),
		dialog: async (request) =>
			"prefill" in request && request.prefill === "old intent" ? { value: "new intent" } : { cancelled: true },
	});
	try {
		await client.request({ type: "get_state" });
		expect(await client.promptAndWait("/intent")).toMatchObject({ disposition: "handled" });
		expect(events.find((row) => row.type === "dialog_answer")).toMatchObject({ value: "new intent" });
		await client.promptAndWait("new requirement", "steer");
		await client.promptAndWait("later requirement", "followUp");
		expect(events.filter((row) => row.type === "input_seen").map((row) => row.behavior)).toEqual(["steer", "followUp"]);
		expect(events.filter((row) => row.type === "agent_settled")).toHaveLength(2);
	} finally {
		await client.close();
	}
});
test.each(["invalid-json", "exit"])("P3 RPC fails closed on %s and rejects its pending command", async (message) => {
	const client = new P3RpcClient({ cli, cwd: path.dirname(cli) });
	try {
		await expect(client.promptAndWait(message)).rejects.toThrow();
	} finally {
		await client.close();
	}
});
