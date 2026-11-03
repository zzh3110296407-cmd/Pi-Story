export const PRIMARY_BOOKS = [837, 527, 1587, 42, 1769] as const;
export const RESERVE_BOOKS = [378, 886, 217] as const;
export const BOOK_LIMITS = {
	capacity: 45,
	costPerPlannedChapter: 0.09,
	stopUsd: 6.5,
	maximumUsd: 7.5,
	perBookUsd: 2,
} as const;

// Selection deliberately accepts only outline targets, never completion rates,
// measured lengths, failures or score results.
export function nextBook(plans: { id: number; target: number | null }[]) {
	const ordered = [...PRIMARY_BOOKS, ...RESERVE_BOOKS];
	if (
		plans.length > ordered.length ||
		plans.some(
			(plan, i) =>
				plan.id !== ordered[i] ||
				(plan.target !== null && (!Number.isSafeInteger(plan.target) || plan.target < 1 || plan.target > 10)),
		)
	)
		throw new Error("Book plans must be the preregistered prefix with observed outline targets");
	const known = plans.every((plan) => plan.target !== null);
	const plannedChapters = known ? plans.reduce((sum, plan) => sum + (plan.target ?? 0), 0) : null;
	const id =
		plans.length < PRIMARY_BOOKS.length || (plannedChapters !== null && plannedChapters < BOOK_LIMITS.capacity)
			? (ordered[plans.length] ?? null)
			: null;
	return {
		id,
		plannedChapters,
		capacityReached: plannedChapters === null ? null : plannedChapters >= BOOK_LIMITS.capacity,
		capacityUnknown: !known && plans.length >= PRIMARY_BOOKS.length,
		reservesUsed: Math.max(0, plans.length - PRIMARY_BOOKS.length),
	};
}

export function bookBudgetPreflight(spentAndReservedUsd: number, remainingPlannedChapters: number) {
	if (
		!Number.isFinite(spentAndReservedUsd) ||
		spentAndReservedUsd < 0 ||
		!Number.isSafeInteger(remainingPlannedChapters) ||
		remainingPlannedChapters < 1
	)
		throw new Error("Finite recorded fees and a positive planned chapter count are required");
	const estimateUsd = remainingPlannedChapters * BOOK_LIMITS.costPerPlannedChapter;
	return {
		spentAndReservedUsd,
		remainingPlannedChapters,
		estimateUsd,
		projectedUsd: spentAndReservedUsd + estimateUsd,
		allowed: spentAndReservedUsd + estimateUsd <= BOOK_LIMITS.stopUsd,
	};
}

export function interruptionDecision(facts: {
	parentPid?: number;
	rpcPid?: number;
	parentAlive: boolean | null;
	rpcAlive: boolean | null;
	exit?: "completed" | "failed";
	productError: boolean;
	timedOut: boolean;
	cancelled: boolean;
	previousRestarts: number;
	unclassifiedDiagnostic?: boolean;
}) {
	if (!Number.isInteger(facts.previousRestarts) || facts.previousRestarts < 0)
		throw new Error("Invalid restart history");
	if (facts.exit === "completed") return { classification: "completed", restart: false, qualityIncluded: true };
	if (facts.productError || facts.timedOut || facts.cancelled || facts.exit === "failed")
		return { classification: "product_failure", restart: false, qualityIncluded: true };
	if (facts.parentAlive || facts.rpcAlive) return { classification: "running", restart: false, qualityIncluded: true };
	if (
		!facts.parentPid ||
		!facts.rpcPid ||
		facts.parentAlive === null ||
		facts.rpcAlive === null ||
		facts.unclassifiedDiagnostic
	)
		return { classification: "insufficient_process_evidence", restart: false, qualityIncluded: true };
	return {
		classification: "external_interruption",
		restart: facts.previousRestarts === 0,
		qualityIncluded: false,
		accounting: "retain_all_fees_and_hard_gate_evidence",
		repeatedInterruptionIsMissing: facts.previousRestarts > 0,
	};
}
