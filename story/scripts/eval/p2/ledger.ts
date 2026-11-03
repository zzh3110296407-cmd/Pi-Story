import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Usage } from "@pi-story/core";

interface Reservation {
	requestId: string;
	time: string;
	suiteId: string;
	runId: string;
	role: string;
	model: string;
	reservedCostUsd: number;
	reservedInputTokens: number;
	reservedOutputTokens: number;
	runLimitUsd: number;
	maximumCostUsd?: number;
}
interface Charge extends Reservation {
	finishedAt: string;
	usage: Usage | null;
	stopReason: string;
	knownCostUsd: number | null;
	knownNotDispatched?: true;
	classification?: string;
}
function rows<T>(file: string): T[] {
	return existsSync(file)
		? readFileSync(file, "utf8")
				.split(/\r?\n/u)
				.filter(Boolean)
				.map((line) => JSON.parse(line) as T)
		: [];
}
const amount = (value: number) => Number.isFinite(value) && value >= 0;

export class UsageLedger {
	readonly ledgerFile: string;
	readonly reservationsFile: string;
	readonly limits: { stopUsd: number; maximumUsd: number };
	constructor(ledgerFile: string, reservationsFile: string, limits = { stopUsd: 20, maximumUsd: 25 }) {
		this.ledgerFile = ledgerFile;
		this.reservationsFile = reservationsFile;
		if (!amount(limits.stopUsd) || !amount(limits.maximumUsd) || limits.stopUsd > limits.maximumUsd)
			throw new Error("Invalid fee limits");
		this.limits = limits;
		mkdirSync(path.dirname(ledgerFile), { recursive: true });
		mkdirSync(path.dirname(reservationsFile), { recursive: true });
	}
	snapshot(runId?: string) {
		const reservations = rows<Reservation>(this.reservationsFile);
		const charges = new Map(rows<Charge>(this.ledgerFile).map((row) => [row.requestId, row]));
		const seen = new Set<string>();
		let knownUsd = 0,
			reservedUsd = 0,
			unknownCalls = 0,
			requests = 0;
		for (const reservation of reservations) {
			if (seen.has(reservation.requestId) || !amount(reservation.reservedCostUsd))
				throw new Error("Invalid fee reservation journal");
			seen.add(reservation.requestId);
			if (runId !== undefined && reservation.runId !== runId) continue;
			requests++;
			const charge = charges.get(reservation.requestId);
			if (charge?.knownCostUsd !== null && charge?.knownCostUsd !== undefined) {
				if (!amount(charge.knownCostUsd)) throw new Error("Invalid known fee");
				knownUsd += charge.knownCostUsd;
			} else {
				unknownCalls++;
				reservedUsd += reservation.reservedCostUsd;
			}
		}
		return { knownUsd, reservedUsd, unknownCalls, requests, totalUsd: knownUsd + reservedUsd };
	}
	reserve(input: Omit<Reservation, "requestId" | "time">): string {
		if (!amount(input.reservedCostUsd) || !amount(input.runLimitUsd))
			throw new Error("A finite fee allowance is required");
		const total = this.snapshot().totalUsd;
		if (total >= this.limits.stopUsd || total + input.reservedCostUsd > this.limits.stopUsd)
			throw new Error(`Fee $${this.limits.stopUsd} stop threshold reached before dispatch`);
		if (total + (input.maximumCostUsd ?? input.reservedCostUsd) > this.limits.maximumUsd)
			throw new Error(`Fee $${this.limits.maximumUsd} maximum could be exceeded`);
		if (this.snapshot(input.runId).totalUsd + input.reservedCostUsd > input.runLimitUsd)
			throw new Error("P2 run fee allowance exhausted");
		const reservation: Reservation = { ...input, requestId: randomUUID(), time: new Date().toISOString() };
		appendFileSync(this.reservationsFile, `${JSON.stringify(reservation)}\n`, "utf8");
		return reservation.requestId;
	}
	complete(
		requestId: string,
		usage: Usage | null,
		stopReason: string,
		knownNotDispatched = false,
		classification?: string,
	): void {
		const reservation = rows<Reservation>(this.reservationsFile).find((row) => row.requestId === requestId);
		if (!reservation || rows<Charge>(this.ledgerFile).some((row) => row.requestId === requestId))
			throw new Error("Unknown or already recorded request");
		if (usage && !amount(usage.cost.total)) throw new Error("Invalid reported request fee");
		const charge: Charge = {
			...reservation,
			finishedAt: new Date().toISOString(),
			usage,
			stopReason,
			...(classification ? { classification } : {}),
			knownCostUsd: knownNotDispatched ? 0 : (usage?.cost.total ?? null),
			...(knownNotDispatched ? { knownNotDispatched: true as const } : {}),
		};
		appendFileSync(this.ledgerFile, `${JSON.stringify(charge)}\n`, "utf8");
	}
}
