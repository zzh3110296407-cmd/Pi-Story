import type { EvidenceRecord } from "./metering.ts";
import type { HumanScore, ScoreOptions } from "./score.ts";
import { scoreEvidenceV2 } from "./score-v2.ts";

// 26 retains the numeric thresholds and hard gates; semantic coverage matching
// belongs to the qualified judge, not a string-based automatic matcher.
export function scoreEvidenceV3(
	records: EvidenceRecord[],
	judgments: HumanScore[],
	hardOnly = false,
	options: ScoreOptions = {},
) {
	const reused = records.filter((row) => row.type === "role_output_reused");
	const identities = reused.map((row) => JSON.stringify([row.caseId, row.toolCallId, row.recoveredReservationId]));
	if (
		new Set(identities).size !== identities.length ||
		reused.some(
			(row) => typeof row.originalReservationId !== "string" || typeof row.recoveredReservationId !== "string",
		)
	)
		throw new Error("Recovered call identity is absent or duplicated");
	// A fresh SDK session allocates new transaction IDs. Normalize only this
	// explicit recovery link for the audit; all output/usage/source fields stay
	// unchanged and are still compared against the original completed journal.
	const audit = reused.length
		? records.map((row) => {
				if (
					row.type !== "tool_result" ||
					!row.message ||
					typeof row.message !== "object" ||
					!("details" in row.message)
				)
					return row;
				const message = row.message as { toolCallId?: string; details?: { calls?: Record<string, unknown>[] } };
				if (!Array.isArray(message.details?.calls)) return row;
				return {
					...row,
					message: {
						...message,
						details: {
							...message.details,
							calls: message.details.calls.map((call) => {
								const link = reused.find(
									(old) =>
										old.caseId === row.caseId &&
										old.toolCallId === message.toolCallId &&
										old.recoveredReservationId === call.id,
								);
								return link ? { ...call, id: link.originalReservationId } : call;
							}),
						},
					},
				};
			})
		: records;
	const result = scoreEvidenceV2(audit, judgments, hardOnly, options);
	return {
		...result,
		scoringVersion: "p2r3-26@1",
		metrics: result.metrics.filter((metric) => !["E02", "E03", "E04", "E05"].includes(metric.id)),
		judgmentProtocol: {
			ledger: "coverage-rev20261031",
			facts: "predicate-and-entity-rev20261031",
			notApplicable: "excluded from scored denominator; retained in judgment source",
		},
	};
}
