import type { Static, TSchema } from "typebox";
import type { CommandContext } from "../ports/index.ts";
import { validate } from "../schema/index.ts";
import { type CommandResult, failure, success } from "./result.ts";

export const batchGuard = (ctx: Pick<CommandContext, "batch">): CommandResult<never> | null =>
	ctx.batch?.committed ? failure("STALE_OR_CONFLICT", "本批已提交一章，请在下一回合继续") : null;
export function validatedResult<T extends TSchema>(schema: T, details: unknown): CommandResult<Static<T>> {
	const result = validate(schema, details);
	return result.ok
		? success(result.value)
		: failure(
				"DOMAIN_INVALID",
				"输入字段不符合要求",
				result.errors.map((issue) => `${issue.path}: ${issue.message}`),
			);
}
