import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { schemas, validate } from "../../../packages/core/src/schema/index.ts";
import type { EvidenceRecord } from "../p2/metering.ts";

export function stopAfterOpening(pi: ExtensionAPI, emit: (record: EvidenceRecord) => void) {
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "toolResult" || event.message.toolName !== "submit_outline" || event.message.isError)
			return;
		if (!validate(schemas.OutlineDetails, event.message.details).ok) return;
		emit({ type: "measurement_stop", reason: "opening_complete", afterToolCallId: event.message.toolCallId });
		ctx.abort();
	});
}
