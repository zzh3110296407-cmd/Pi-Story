// IF-6: runtime entry points. Internal assembly and validation helpers stay in their modules.

export type { ConstraintsInput, ControlChange } from "./control/index.ts";
export { authorControl, authorGoal, submitConstraints } from "./control/index.ts";
export { commit, reviewDraft, writeDraft } from "./flow/commands.ts";
export { writeNextChapter } from "./flow/next.ts";
export type { BranchEntry, FoldCache, StoryModel, StoryState } from "./fold/index.ts";
export { foldBranch } from "./fold/index.ts";
export type { BibleItemInput } from "./foundation/index.ts";
export { submitBible, updateBible } from "./foundation/index.ts";
export { patchOutline, setChapterIntent, submitOutline } from "./plan/index.ts";
export type {
	CommandContext,
	EffectiveSettings,
	EntrySource,
	ModelPort,
	ModelRequest,
	Ports,
	PriceTable,
	Role,
	RoleSettings,
	RuleSource,
} from "./ports/index.ts";
export type { Eligibility } from "./production/index.ts";
export { checkCommitEligibility, checkDraft, patchDraft, respondObservations } from "./production/index.ts";
export type {
	BranchSummary,
	ExportContext,
	ExportFile,
	ExportFormat,
	ReadResult,
	ReadStoryQuery,
	StoryView,
	TreeNode,
} from "./projections/index.ts";
export { readStory, toBranchList, toExport, toManuscript, toStoryView } from "./projections/index.ts";
export type {
	Basis,
	BibleChange,
	BibleDetails,
	CallRecord,
	ChapterSummary,
	CheckDetails,
	Claim,
	Cognition,
	CommitDetails,
	CommitRecord,
	ConstraintsDetails,
	ControlEntry,
	DeltaProposal,
	DraftDetails,
	Fact,
	GoalEntry,
	Hook,
	IntentDetails,
	InterruptedEntry,
	MacroDetails,
	ModelFailure,
	Observation,
	OutlineDetails,
	Patch,
	Relation,
	ResponseDetails,
	ReviewDetails,
	ReviewOutput,
	StateDelta,
	StorySettingsEntry,
	Usage,
} from "./schema/index.ts";
export type { CommandResult, DomainError, ErrorCode } from "./shared/result.ts";
export type { BudgetCallRecord, BudgetSnapshot, SessionUsage, UsageSummary } from "./usage/index.ts";

// C7's reference implementation is available under the port's public name. Its type remains
// structural, so adapters may supply their own implementation or a test double.
import type { BudgetGuard as BudgetGuardPort } from "./ports/index.ts";
import { BudgetGuard as ReferenceBudgetGuard } from "./usage/index.ts";
export type BudgetGuard = BudgetGuardPort;
export const BudgetGuard = ReferenceBudgetGuard;

// correctState/authorSettings are v1.1; they deliberately have no command export in v1.0.
