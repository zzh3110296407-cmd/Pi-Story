import type { CapturedAction } from "../p3/scenario.ts";

const READ_ONLY = new Set(["read_story", "read_chapter", "read_state", "get_character"]);

export function decisiveAction(actions: CapturedAction[], maximumReads: number) {
	let readOnlyCalls = 0;
	for (const action of actions) {
		if (action.tool && READ_ONLY.has(action.tool)) {
			readOnlyCalls++;
			continue;
		}
		return { action, readOnlyCalls, exceeded: readOnlyCalls > maximumReads };
	}
	return { action: null, readOnlyCalls, exceeded: readOnlyCalls > maximumReads };
}
