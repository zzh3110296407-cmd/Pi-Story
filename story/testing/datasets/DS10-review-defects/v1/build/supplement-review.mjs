import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';import path from 'node:path';
export function writeSupplement(root,items){
 if(existsSync(path.join(root,'labels/delegated-review-r2.json')))return; // Completed r2 decisions stay in their original files.
 const out='D:/AI/Story Dome/新版综合方案/测试结果/P2/人工复核';mkdirSync(out,{recursive:true});
 const fresh=items.filter(i=>i.aiLabel.reviewStatus==='requires_supplemental_review');
 const record={revision:'r2',instructions:'约30–40分钟。14项：4处整章第一人称过去时重述、4处配套时间线缺陷的新锚点、6处保留正确叙述的数量矛盾。请重新判定成立性、严重度、scope与证据。四处structural只是候选，不能由覆盖率计数自动判成。原36项AI复核及其6处local改判保留不变。',reviewer:null,date:null,reviewMode:null,originalReview:'DS10-v1-缺陷复核.json',retainedR1ReviewItems:items.filter(i=>!fresh.includes(i)).map(i=>i.itemId),items:fresh.map(i=>({...i,variantPath:path.join(root,'acceptance/variants',i.variantId+'.md').replaceAll('\\','/'),entriesPath:path.join(root,'acceptance/entries',i.variantId+'.json').replaceAll('\\','/'),authorVerdict:null,changedTo:null,note:null})),baselineCandidates:JSON.parse(readFileSync(path.join(root,'labels/unplanned-candidates.json'),'utf8')).items};
 const j=path.join(out,'DS10-v1-r2补充复核.json');if(!existsSync(j))writeFileSync(j,JSON.stringify(record,null,2)+'\n');
 let md='# DS10 v1 r2 补充复核（尚未冻结）\n\n预计30–40分钟。14项需核对：4处整体重述、4处配套时间线新锚点、6处保留正确叙述后的数量矛盾。其余22项沿用已完成的AI复核。原36项复核单原判和理由保留不改。填写同名JSON的authorVerdict（agree/change）、changedTo、note及reviewer/date；请如实标明AI身份。\n\n原六处风格引言全部接受major/local改判。现在四份第三人称正文被第一人称过去时整章重述替换，动作主语、内心活动与对别人认知的交代均重写，原段落没有藏在引言后面。structural仍是待判候选：请按修复是否需要重述全章判断，不能按行数或补丁个数判断。正文情节是否引入了额外偏离，也属于本次核对范围。\n\n对照文本与冻结DS09仍字节一致。另有1项底本表述歧义候选，单列在末尾，不计入36处注入或4处候选。\n\n';
 for(const i of record.items){const d=i.aiLabel;md+=`## ${i.itemId}\n\n${d.category} / ${d.severity} / ${d.scope}（待核对）\n\n[当前变体](<${i.variantPath}>) / [实际输入](<${i.entriesPath}>)\n\n`;for(const s of d.spans)md+=`行 ${s.lines.start}–${s.lines.end}\n\n### 原文\n\n${s.original}\n\n### 改后\n\n${s.changed}\n\n`;md+=`来源：\n\n${d.sources.map(s=>`- ${s.kind} ${s.ref??''}: ${s.quote}`).join('\n')}\n\n理由：${d.reason}\n\n复核：□同意 □改为________；备注________\n\n`;}
 md+='## 底本候选（不计入注入数）\n\n'+record.baselineCandidates.map(i=>`${i.id}\n\n原句片段：${i.quote}\n\n${i.reason}\n\n${i.handling}\n\n复核：________`).join('\n\n');
 const m=path.join(out,'DS10-v1-r2补充复核.md');if(!existsSync(m))writeFileSync(m,md);
}
