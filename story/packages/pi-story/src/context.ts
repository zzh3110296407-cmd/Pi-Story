import { toStoryView } from "@pi-story/core";
import type { SessionState } from "./session.ts";

export function storyProgress(state: SessionState): string {
	const model = state.source.model();
	const view = toStoryView(model);
	const latest = view.chapters.at(-1);
	return JSON.stringify({
		lastChapter: model.lastChapter,
		nextChapter: model.lastChapter + 1,
		targetChapter: model.policy.targetChapter ?? null,
		plannedChapters: model.outline.length,
		budget: model.policy.budget ?? null,
		usage: state.services.guard.summary(),
		latestChapter: latest
			? {
					n: latest.n,
					quality: latest.quality,
					risks: view.state.risks.find((risk) => risk.chapter === latest.n)?.observationIds ?? [],
				}
			: null,
		openObservations: view.draft?.eligibility.openObservations ?? 0,
		unconfirmed: view.state.provisional.length,
		consecutiveFailures: model.failures[model.lastChapter + 1] ?? 0,
		stopReason:
			state.stopReason ??
			(model.policy.targetChapter !== undefined && model.lastChapter >= model.policy.targetChapter
				? "goal_reached"
				: (model.failures[model.lastChapter + 1] ?? 0) >= 2
					? "consecutive_failures"
					: model.policy.targetChapter === undefined
						? "goal_off"
						: null),
	});
}
