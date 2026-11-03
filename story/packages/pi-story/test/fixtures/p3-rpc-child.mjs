import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let editor;
input.on("line", (line) => {
	const command = JSON.parse(line);
	if (command.type === "extension_ui_response") {
		emit({ type: "dialog_answer", value: command.value, cancelled: command.cancelled });
		emit({ type: "response", id: editor.id, command: "prompt", success: true, data: { disposition: "handled" } });
		return;
	}
	if (command.message === "/intent") {
		editor = command;
		emit({ type: "extension_ui_request", id: "dialog-1", method: "editor", title: "intent", prefill: "old intent" });
		return;
	}
	if (command.message === "invalid-json") {
		process.stdout.write("{broken\n");
		return;
	}
	if (command.message === "exit") {
		process.exit(3);
	}
	if (command.message === "handled-late") {
		setTimeout(
			() =>
				emit({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "handled" } }),
			100,
		);
		return;
	}
	if (command.type === "prompt") {
		emit({ type: "input_seen", behavior: command.streamingBehavior ?? "idle", message: command.message });
		const frame = `${JSON.stringify({ type: "agent_settled", aborted: false })}\n`;
		process.stdout.write(frame.slice(0, 9));
		setTimeout(() => {
			process.stdout.write(frame.slice(9));
			emit({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
		}, 5);
	} else emit({ type: "response", id: command.id, command: command.type, success: true, data: { isStreaming: false } });
});
