import { createHash } from "node:crypto";
import type { JsonObject, ToolResultMessage } from "@earendil-works/pi-ai";
import { type Static, type TSchema, Type } from "typebox";
import { Check } from "typebox/value";

const repairSchema = Type.Object(
	{
		strategy: Type.Literal("remove_one_trailing_brace"),
		originalArguments: Type.String({ minLength: 1 }),
		originalDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		repairedDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	},
	{ additionalProperties: false },
);
export type ArgumentsRepair = Static<typeof repairSchema>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function repairReceipt(message: ToolResultMessage, repair: ArgumentsRepair): ToolResultMessage {
	return {
		...message,
		details: {
			...(message.details !== null && typeof message.details === "object" ? message.details : {}),
			argumentsRepair: repair,
		},
		content: [
			...message.content,
			{
				type: "text",
				text: "已显式进行参数语法修复：仅删除末尾一个 }。首次参数仍记为不合格；领域校验与实际结果保持生效。",
			},
		],
	};
}

export function validRepair(value: unknown): value is ArgumentsRepair {
	return (
		Check(repairSchema, value) &&
		hash(value.originalArguments) === value.originalDigest &&
		hash(value.originalArguments.trimEnd().slice(0, -1)) === value.repairedDigest
	);
}

export function repairArguments(
	error: string,
	schema: TSchema,
): { arguments: JsonObject; repair: ArgumentsRepair } | undefined {
	const separator = "\n\nReceived arguments:\n",
		position = error.indexOf(separator);
	if (position < 0) return;
	const original = error.slice(position + separator.length);
	try {
		JSON.parse(original);
		return;
	} catch {
		/* Only malformed source arguments are eligible. */
	}
	if (!original.trimEnd().endsWith("}")) return;
	const repaired = original.trimEnd().slice(0, -1);
	try {
		const value: unknown = JSON.parse(repaired);
		if (value === null || typeof value !== "object" || Array.isArray(value) || !Check(schema, value)) return;
		return {
			arguments: value as JsonObject,
			repair: {
				strategy: "remove_one_trailing_brace",
				originalArguments: original,
				originalDigest: hash(original),
				repairedDigest: hash(repaired),
			},
		};
	} catch {
		return;
	}
}
