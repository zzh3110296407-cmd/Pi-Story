import { type StoryModel, stateAt } from "../fold/index.ts";
import {
	type DeltaProposal,
	type DraftDetails,
	type Fact,
	type StateDelta,
	schemas,
	validate,
} from "../schema/index.ts";
import { currentBasis } from "../shared/basis.ts";
import { type CommandResult, failure, success } from "../shared/result.ts";
import { inDialogue, sentences, validId } from "../shared/text.ts";

export interface ValidatedDelta {
	delta: StateDelta;
	evidence: Record<string, string>;
	refs: Record<string, string>;
	downgraded: string[];
}
export const singleValue = (predicate: string): boolean =>
	["alive", "identity", "true_identity", "holder", "location"].includes(predicate) || predicate.startsWith("quantity:");

function historicalFacts(m: StoryModel): Fact[] {
	const facts = new Map<string, Fact>();
	for (const commit of m.commits) {
		for (const fact of commit.delta.factOps.upsert) facts.set(fact.id, structuredClone(fact));
		for (const op of commit.delta.factOps.expire) {
			const fact = facts.get(op.id);
			if (fact) fact.validUntil = op.validUntil;
		}
	}
	return [...facts.values()];
}
function decimalParts(value: number): { integer: bigint; scale: number } {
	const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e");
	const fraction = mantissa.split(".")[1]?.length ?? 0;
	return { integer: BigInt(mantissa.replace(".", "")), scale: fraction - Number(exponent) };
}
function balances(before: number, change: number, after: number): boolean {
	const values = [before, change, after].map(decimalParts);
	const scale = Math.max(...values.map((value) => value.scale));
	const [a, b, c] = values.map((value) => value.integer * 10n ** BigInt(scale - value.scale));
	return a + b === c;
}
function overlaps(a: Fact, b: Fact): boolean {
	return (
		(a.validFrom ?? 0) <= (b.validUntil ?? Number.POSITIVE_INFINITY) &&
		(b.validFrom ?? 0) <= (a.validUntil ?? Number.POSITIVE_INFINITY)
	);
}

export function validateDelta(m: StoryModel, draft: DraftDetails, raw: unknown): CommandResult<ValidatedDelta> {
	const parsed = validate(schemas.DeltaProposal, raw);
	if (!parsed.ok)
		return failure(
			"PARSE_FAILURE",
			"状态提议格式不合格",
			parsed.errors.map((item) => `${item.path}: ${item.message}`),
		); // D11
	const proposal: DeltaProposal = parsed.value;
	const n = draft.chapter;
	if (n !== m.lastChapter + 1) return failure("DOMAIN_INVALID", "状态提议只能结算下一章", [String(n)]);
	const chapterSentences = sentences(draft.text, n, draft.sentenceRule);
	const evidence: Record<string, string> = {};
	const all = [...proposal.facts, ...proposal.claims, ...proposal.cognitions, ...proposal.relations, ...proposal.hooks];
	const refs: Record<string, string> = {};
	const seen = new Set<string>();
	// Errors address the submitted fields, so the caller can repair a proposal
	// without reverse-mapping temporary or newly allocated canonical IDs.
	const locations = new Map<string, string>();
	for (const group of ["facts", "claims", "cognitions", "relations", "hooks"] as const)
		proposal[group].forEach((row, index) => {
			locations.set(row.ref, `${group}[${index}]`);
		});
	const location = (ref: string) => locations.get(ref) ?? ref;
	const rejected = (message: string, ref: string, field?: string) =>
		failure<ValidatedDelta>("DOMAIN_INVALID", message, [`${location(ref)}${field ? `.${field}` : ""}`]);
	for (const row of all) {
		if (seen.has(row.ref)) return rejected("临时编号不能重复", row.ref);
		seen.add(row.ref);
		for (const number of row.sentences) {
			const sentence = chapterSentences[number - 1];
			if (!sentence) return rejected("证据句号不在本章正文中", row.ref, "sentences"); // D2
			evidence[sentence.id] = sentence.text;
		}
	}
	const evidenceRefs = (numbers: number[]) => numbers.map((number) => chapterSentences[number - 1].id);
	const quoted = (row: DeltaProposal["facts"][number]) =>
		row.op === "upsert" &&
		(row.mode ?? "narrated") === "narrated" &&
		row.sentences.every((number) => inDialogue(draft.text, chapterSentences[number - 1]));
	const state = stateAt(m);
	const oldFacts = historicalFacts(m);
	const counters = { F: 0, S: 0, K: 0, H: 0 };
	for (const commit of m.commits)
		for (const [kind, records] of Object.entries({
			F: commit.delta.factOps.upsert,
			S: commit.delta.claimOps.add,
			K: commit.delta.cognitionOps.add,
			H: commit.delta.hookOps.upsert,
		}))
			for (const item of records)
				counters[kind as keyof typeof counters] = Math.max(
					counters[kind as keyof typeof counters],
					Number(item.id.slice(2)),
				);
	const allocate = (kind: keyof typeof counters) => `${kind}-${++counters[kind]}`;
	for (const row of proposal.facts)
		refs[row.ref] = row.op === "upsert" ? allocate(quoted(row) ? "S" : "F") : (row.id ?? "");
	for (const row of proposal.claims) refs[row.ref] = allocate("S");
	for (const row of proposal.cognitions) refs[row.ref] = row.op === "add" ? allocate("K") : (row.id ?? "");
	for (const row of proposal.relations) refs[row.ref] = row.key;
	for (const row of proposal.hooks) refs[row.ref] = row.op === "upsert" && !row.id ? allocate("H") : (row.id ?? "");
	for (const [ref, id] of Object.entries(refs)) if (!locations.has(id)) locations.set(id, location(ref));
	const resolve = (ref: string) => refs[ref] ?? ref;
	const entity = (ref: string): boolean => {
		if (/^(?:char|place):/u.test(ref)) return validId(ref) && !!m.bible[ref] && m.bible[ref].effectiveFromChapter <= n;
		if (/^(?:item|org):/u.test(ref)) return validId(ref);
		return true;
	};
	const delta: StateDelta = {
		chapter: n,
		basis: currentBasis(m, n, draft.digest),
		factOps: { upsert: [], expire: [], confirm: [] },
		claimOps: { add: [] },
		cognitionOps: { add: [], supersede: [], confirm: [] },
		relationOps: { upsert: [], confirm: [] },
		hookOps: { upsert: [], advance: [], mention: [], resolve: [], defer: [], supersede: [] },
		summary: { chapter: n, ...proposal.summary, stateChanges: [], hookActivity: [] },
		issues: [...proposal.issues],
	};
	const downgraded: string[] = [];
	for (const row of proposal.facts) {
		const old = row.id ? state.facts.find((fact) => fact.id === resolve(row.id ?? "")) : undefined;
		const ev = evidenceRefs(row.sentences);
		if (row.op === "confirm" && (row.certainty === "uncertain" || row.change !== undefined))
			return rejected(
				"确认提议不能同时声明不确定或数量变化",
				row.ref,
				row.change !== undefined ? "change" : "certainty",
			);
		if (row.op !== "upsert" && !old) return rejected("事实目标不存在或已失效", row.ref, "id"); // D1
		if (row.op === "confirm" && old) {
			if (
				old.status !== "provisional" ||
				(row.subject !== undefined && row.subject !== old.subject) ||
				(row.predicate !== undefined && row.predicate !== old.predicate) ||
				(row.object !== undefined && JSON.stringify(row.object) !== JSON.stringify(old.object)) ||
				(row.mode !== undefined && row.mode !== old.mode) ||
				(row.validFrom !== undefined && row.validFrom !== old.validFrom) ||
				(row.validUntil !== undefined && row.validUntil !== old.validUntil) ||
				(row.visibility !== undefined && row.visibility !== old.visibility)
			)
				return rejected(
					"确认只能改变未确认状态，不能改写事实内容",
					row.ref,
					(["subject", "predicate", "object", "mode", "validFrom", "validUntil", "visibility"] as const).find(
						(key) => row[key] !== undefined && JSON.stringify(row[key]) !== JSON.stringify(old[key]),
					) ?? "id",
				); // D9
			delta.factOps.confirm.push({ id: old.id, evidence: ev });
			continue;
		}
		if (row.op === "expire" && old) {
			if (
				row.mode === "recalled_past" ||
				row.validUntil === undefined ||
				row.validUntil < (old.validFrom ?? old.sourceChapter) ||
				row.validUntil >= n
			)
				return rejected("失效有效期必须属于已发生的情节，回忆不能使当前事实失效", row.ref); // D4
			delta.factOps.expire.push({ id: old.id, validUntil: row.validUntil, evidence: ev });
			continue;
		}
		if (
			row.subject === undefined ||
			row.predicate === undefined ||
			row.object === undefined ||
			row.certainty === undefined
		)
			return failure("PARSE_FAILURE", "新增事实缺少必要字段", [row.ref]);
		if (!entity(row.subject) || (typeof row.object === "string" && !entity(row.object)))
			return rejected("人物或地点引用不存在或尚未生效", row.ref, !entity(row.subject) ? "subject" : "object"); // D1
		if (row.id) return rejected("已有事实不能原地改写，请使旧事实失效后新增", row.ref, "id");
		if (quoted(row)) {
			const speaker = row.speaker ?? "unknown";
			if (speaker !== "unknown" && (!speaker.startsWith("char:") || !entity(speaker)))
				return rejected("对白发言者必须是有效人物或unknown", row.ref, "speaker");
			delta.claimOps.add.push({
				id: refs[row.ref],
				speaker,
				content: row.sentences.map((number) => chapterSentences[number - 1].text).join(" "),
				chapter: n,
				evidence: ev,
			});
			downgraded.push(row.ref);
			delta.issues.push(`对白事实${row.ref}已降为转述${speaker === "unknown" ? "，发言者未确定" : ""}`);
			continue;
		}
		const mode = row.mode ?? "narrated";
		const validFrom = row.validFrom === undefined ? (mode === "recalled_past" ? null : n) : row.validFrom;
		const validUntil = row.validUntil ?? null;
		if (
			(mode === "narrated" && validFrom !== n) ||
			(mode === "recalled_past" && validFrom !== null && validFrom >= n) ||
			(validFrom !== null && validUntil !== null && validFrom > validUntil)
		)
			return rejected("事实起点必须符合叙述方式且不晚于终点；未知回忆起点用null", row.ref, "validFrom");
		if (validUntil !== null && (validUntil > n || (mode === "narrated" && validUntil < n)))
			return rejected("事实有效期不能表示尚未发生的计划或倒置的当下事实", row.ref); // D5 mechanical boundary
		const current = state.facts.filter((fact) => fact.subject === row.subject && fact.predicate === row.predicate);
		if (
			mode === "recalled_past" &&
			singleValue(row.predicate) &&
			current.length &&
			(validUntil === null || validUntil >= n)
		)
			return rejected("与当前单值事实并存的回忆必须限定在过去", row.ref, "validUntil"); // D4
		if (
			row.predicate === "alive" &&
			(!row.subject.startsWith("char:") || !["alive", "dead", "unknown"].includes(String(row.object)))
		)
			return rejected("生存状态需要人物主语与词表中的取值", row.ref);
		if (["identity", "true_identity"].includes(row.predicate) && !row.subject.startsWith("char:"))
			return rejected("身份事实需要人物主语", row.ref);
		if (
			row.predicate === "holder" &&
			(!row.subject.startsWith("item:") || typeof row.object !== "string" || !/^(?:char|org):/u.test(row.object))
		)
			return rejected("归属事实需要物品主语与人物或组织宾语", row.ref);
		if (row.predicate === "location" && !/^(?:char|item):/u.test(row.subject))
			return rejected("位置事实需要人物或物品主语", row.ref);
		if (row.predicate.startsWith("quantity:")) {
			if (!/^(?:char|org):/u.test(row.subject) || typeof row.object !== "object")
				return rejected("数量事实需要数值与单位", row.ref);
			if (row.change !== undefined) {
				const previous = current.find(
					(fact) =>
						typeof fact.object === "object" &&
						fact.object.unit === (typeof row.object === "object" ? row.object.unit : ""),
				);
				if (
					!previous ||
					typeof previous.object !== "object" ||
					!balances(previous.object.value, row.change, row.object.value)
				)
					return rejected("旧数量加变化量必须等于新数量且单位相同", row.ref, "change"); // D6
			}
		}
		delta.factOps.upsert.push({
			id: refs[row.ref],
			subject: row.subject,
			predicate: row.predicate,
			object: row.object,
			validFrom,
			validUntil,
			mode,
			status: row.certainty === "uncertain" ? "provisional" : "confirmed",
			...(row.uncertainReason ? { uncertainReason: row.uncertainReason } : {}),
			visibility: row.visibility ?? "public",
			evidence: ev,
			sourceChapter: n,
		});
	}
	const expiring = new Map(delta.factOps.expire.map((op) => [op.id, op.validUntil]));
	for (const row of proposal.facts.filter((row) => row.op === "upsert" && row.mode === "recalled_past"))
		if (
			state.facts.some((old) => old.subject === row.subject && old.predicate === row.predicate && expiring.has(old.id))
		)
			return failure(
				"DOMAIN_INVALID",
				"回忆不能使同一主语谓词的当前事实失效",
				proposal.facts
					.filter(
						(op) =>
							op.op === "expire" &&
							state.facts.some(
								(old) => old.id === op.id && old.subject === row.subject && old.predicate === row.predicate,
							),
					)
					.map((op) => location(op.ref)),
			); // D4
	const allFacts = [
		...oldFacts.map((fact) =>
			expiring.has(fact.id) ? { ...fact, validUntil: expiring.get(fact.id) ?? fact.validUntil } : fact,
		),
		...delta.factOps.upsert,
	];
	for (const fact of delta.factOps.upsert)
		if (
			singleValue(fact.predicate) &&
			allFacts.some(
				(other) =>
					other.id !== fact.id &&
					other.subject === fact.subject &&
					other.predicate === fact.predicate &&
					overlaps(fact, other),
			)
		) {
			if (fact.validFrom === null)
				return failure("DOMAIN_INVALID", "回忆起点未知，无法排除历史区间重叠；请依据正文补充validFrom", [
					`${location(fact.id)}.validFrom`,
				]);
			return failure(
				"DOMAIN_INVALID",
				"同一主语和单值谓词在同一章不能有多个有效事实",
				delta.factOps.upsert
					.filter((item) => item.subject === fact.subject && item.predicate === fact.predicate)
					.map((item) => location(item.id)),
			); // D6
		}
	for (const row of proposal.claims) {
		if (!entity(row.speaker)) return rejected("转述的发言者引用无效", row.ref, "speaker");
		delta.claimOps.add.push({
			id: refs[row.ref],
			speaker: row.speaker,
			content: row.content,
			chapter: n,
			evidence: evidenceRefs(row.sentences),
		});
	}
	const futureFacts = new Set([...state.facts.map((item) => item.id), ...delta.factOps.upsert.map((item) => item.id)]);
	const futureHooks = new Set([
		...state.hooks.map((item) => item.id),
		...proposal.hooks.filter((item) => item.op === "upsert").map((item) => refs[item.ref]),
	]);
	for (const row of proposal.cognitions) {
		if (row.op === "confirm" && row.certainty === "uncertain")
			return rejected("不确定的认知提议不能执行确认", row.ref, "certainty");
		if (!row.characterId.startsWith("char:") || !entity(row.characterId))
			return rejected("认知角色引用无效", row.ref, "characterId");
		const old = row.id ? state.cognitions.find((item) => item.id === resolve(row.id ?? "")) : undefined;
		if (row.op !== "add" && !old) return rejected("认知目标不存在或已被取代", row.ref, "id");
		const about = row.about ? resolve(row.about) : null;
		if (
			about &&
			!futureFacts.has(about) &&
			!futureHooks.has(about) &&
			!(/^char:[a-z0-9_]+#secret$/u.test(about) && entity(about.slice(0, -7)))
		)
			return rejected("认知指向的事实、伏笔或人物秘密不存在", row.ref, "about");
		if (row.op === "add") {
			if (row.id) return rejected("新增认知不能重用已有编号", row.ref, "id");
			delta.cognitionOps.add.push({
				id: refs[row.ref],
				characterId: row.characterId,
				kind: row.kind,
				content: row.content,
				about,
				acquiredChapter: n,
				via: row.via,
				evidence: evidenceRefs(row.sentences),
				status: row.certainty === "uncertain" ? "provisional" : "confirmed",
				...(row.uncertainReason ? { uncertainReason: row.uncertainReason } : {}),
				supersededBy: null,
			}); // D7 by construction
		} else if (row.op === "confirm" && old) {
			if (
				old.status !== "provisional" ||
				old.characterId !== row.characterId ||
				old.kind !== row.kind ||
				old.content !== row.content ||
				old.via !== row.via ||
				(row.about !== undefined && about !== old.about)
			)
				return rejected(
					"确认不能改写认知内容",
					row.ref,
					(["characterId", "kind", "content", "via", "about"] as const).find(
						(key) => row[key] !== undefined && row[key] !== old[key],
					) ?? "id",
				); // D9
			delta.cognitionOps.confirm.push({ id: old.id, evidence: evidenceRefs(row.sentences) });
		} else if (old) delta.cognitionOps.supersede.push({ id: old.id, by: resolve(row.by ?? "") });
	}
	for (const op of delta.cognitionOps.supersede) {
		const old = state.cognitions.find((item) => item.id === op.id);
		const replacement = [...state.cognitions, ...delta.cognitionOps.add].find((item) => item.id === op.by);
		if (!old || !replacement || op.id === op.by || old.characterId !== replacement.characterId)
			return rejected(
				"取代认知必须指向同一角色的另一条有效认知",
				proposal.cognitions.find((row) => row.op === "supersede" && resolve(row.id ?? "") === op.id)?.ref ?? op.id,
				"id",
			); // D7
	}
	for (const row of proposal.relations) {
		if (row.op === "confirm" && row.certainty === "uncertain")
			return rejected("不确定的关系提议不能执行确认", row.ref, "certainty");
		const [from, to] = row.key.slice(4).split("->");
		if (!entity(`char:${from}`) || !entity(`char:${to}`))
			return rejected("关系两端的人物不存在或尚未生效", row.ref, "key");
		if (row.op === "confirm") {
			const old = state.relations.find((item) => item.key === row.key);
			if (!old || old.status !== "provisional" || (row.stance !== undefined && row.stance !== old.stance))
				return rejected(
					"确认不能改写关系立场",
					row.ref,
					old && row.stance !== undefined && row.stance !== old.stance ? "stance" : "key",
				); // D9
			delta.relationOps.confirm.push({ key: row.key, evidence: evidenceRefs(row.sentences) });
		} else if (row.stance !== undefined)
			delta.relationOps.upsert.push({
				key: row.key,
				from: `char:${from}`,
				to: `char:${to}`,
				stance: row.stance,
				sinceChapter: n,
				evidence: evidenceRefs(row.sentences),
				status: row.certainty === "uncertain" ? "provisional" : "confirmed",
				...(row.uncertainReason ? { uncertainReason: row.uncertainReason } : {}),
			});
	}
	const touchedHooks = new Set<string>();
	for (const row of proposal.hooks) {
		const target = row.id ? resolve(row.id) : refs[row.ref];
		const old = state.hooks.find((hook) => hook.id === target);
		if (row.op !== "upsert" && !old) return rejected("伏笔目标不存在", row.ref, "id");
		if (old && ["resolved", "superseded"].includes(old.status))
			return rejected("已结束的伏笔不能重开，请新增依赖旧线的伏笔", row.ref, "id"); // D8
		if (old?.status === "deferred" && row.op === "defer")
			return rejected("已搁置伏笔不能再次执行搁置迁移", row.ref, "op");
		if (touchedHooks.has(target)) return rejected("同一提议不能对同一伏笔执行多个迁移", row.ref, "id");
		touchedHooks.add(target);
		const ev = evidenceRefs(row.sentences);
		if (row.op === "upsert") {
			if (row.id && !old) return rejected("不能使用不存在的伏笔编号", row.ref, "id");
			const dependsOn = (row.dependsOn ?? old?.dependsOn ?? []).map(resolve);
			if (dependsOn.some((id) => !futureHooks.has(id) || id === target))
				return rejected("伏笔依赖不存在或指向自身", row.ref, "dependsOn");
			delta.hookOps.upsert.push({
				id: target,
				type: row.type ?? old?.type ?? "",
				status: old?.status ?? "open",
				startChapter: old?.startChapter ?? n,
				lastAdvancedChapter: old?.lastAdvancedChapter ?? n,
				...((row.expectedPayoff ?? old?.expectedPayoff)
					? { expectedPayoff: row.expectedPayoff ?? old?.expectedPayoff }
					: {}),
				...(old?.notes ? { notes: old.notes } : {}),
				dependsOn,
			});
		} else if (row.op === "supersede") {
			const by = resolve(row.by ?? "");
			if (
				!futureHooks.has(by) ||
				by === target ||
				state.hooks.some((hook) => hook.id === by && ["resolved", "superseded"].includes(hook.status)) ||
				proposal.hooks.some((hook) => resolve(hook.id ?? "") === by && ["resolve", "supersede"].includes(hook.op))
			)
				return rejected("取代伏笔必须指向另一条有效伏笔", row.ref, "by");
			delta.hookOps.supersede.push({ id: target, by, evidence: ev });
		} else delta.hookOps[row.op].push({ id: target, evidence: ev });
	}
	for (const ref of proposal.summary.characters)
		if (!ref.startsWith("char:") || !entity(ref)) return rejected("章节摘要的人物引用无效", "summary.characters");
	const mutations = [
		...delta.factOps.expire,
		...delta.factOps.confirm,
		...delta.cognitionOps.supersede,
		...delta.cognitionOps.confirm,
	].map((op) => op.id);
	if (new Set(mutations).size !== mutations.length)
		return failure("DOMAIN_INVALID", "同一状态条目不能被重复或冲突地修改", mutations);
	if (new Set(proposal.relations.map((row) => row.key)).size !== proposal.relations.length)
		return failure(
			"DOMAIN_INVALID",
			"同一关系不能重复结算",
			proposal.relations.map((row) => row.key),
		);
	delta.summary.stateChanges = [
		...delta.factOps.upsert.map((item) => item.id),
		...mutations,
		...delta.cognitionOps.add.map((item) => item.id),
		...delta.relationOps.upsert.map((item) => item.key),
	];
	delta.summary.hookActivity = proposal.hooks.map((row) => `${row.op}:${refs[row.ref]}`);
	return success({ delta, evidence, refs, downgraded });
}
