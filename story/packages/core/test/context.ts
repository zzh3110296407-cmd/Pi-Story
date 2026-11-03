import { type BranchEntry, foldBranch } from "../src/fold/index.ts";
import type { CommandContext } from "../src/ports/index.ts";

export function context(entries: BranchEntry[] = []): CommandContext {
	return {
		model: foldBranch(entries),
		settings: {
			localRevision: true,
			roles: {
				writer: { model: "fake" },
				editor: { model: "fake" },
				keeper: { model: "fake" },
				verifier: { model: "fake" },
			},
		},
		ports: {
			entries: {
				branch: () => entries,
				authorMessage: (entryId) => {
					const entry = entries.find((entry) => entry.entryId === entryId);
					return entry?.kind === "authorMessage" ? entry.text : null;
				},
			},
			models: {
				call: async () => {
					throw new Error("Unexpected model call");
				},
			},
			prices: { price: () => null },
			rules: { get: (name) => `[placeholder:${name}]` },
			interjections: { seq: () => 0 },
			budget: { reserve: () => ({ ok: true, reservationId: "r", costUsd: null }), settle: () => {} },
		},
	};
}
