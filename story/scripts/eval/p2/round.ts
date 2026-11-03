export function evaluationRound(args: readonly string[]) {
	if (args.includes("--round3") && args.includes("--repair"))
		throw new Error("Select either --round3 or --repair; fee journals must not be mixed");
	if (args.includes("--round3")) return { stage: "P2R3" as const, limits: { stopUsd: 6.5, maximumUsd: 8 } };
	if (args.includes("--repair")) return { stage: "P2R" as const, limits: { stopUsd: 16, maximumUsd: 20 } };
	return { stage: "P2" as const, limits: { stopUsd: 20, maximumUsd: 25 } };
}
