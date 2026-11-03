import type { StoryModel } from "../fold/index.ts";
import type { Basis } from "../schema/index.ts";

export function currentBasis(m: StoryModel, chapter: number, draftDigest?: string): Basis {
	return {
		canonHead: m.canonHead,
		controlRev: m.controlRev,
		bibleRev: m.bibleRev,
		intentRev: m.intents[chapter]?.rev ?? 0,
		stateRev: m.stateRev,
		...(draftDigest ? { draftDigest } : {}),
	};
}
export function sameBasis(a: Basis, b: Basis): boolean {
	return (
		a.canonHead === b.canonHead &&
		a.controlRev === b.controlRev &&
		a.bibleRev === b.bibleRev &&
		a.intentRev === b.intentRev &&
		a.stateRev === b.stateRev
	);
}
