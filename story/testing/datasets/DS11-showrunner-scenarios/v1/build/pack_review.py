import copy,hashlib,json,shutil,subprocess,sys
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')
BASE=Path(__file__).resolve().parent
ROOT=next(p for p in BASE.parents if (p/'story/package.json').exists())
REVIEW=Path(r'D:\AI\Story Dome\新版综合方案\测试结果\P3\人工复核')
REVIEW.mkdir(parents=True,exist_ok=True)
def read(p):return json.loads(p.read_text(encoding='utf-8'))
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def dump(p,x):
 p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
def link(label,p):return f'[{label}](<{p.as_posix()}>)'
report=read(BASE/'static-validation.json')
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
allrefs=[];devrefs=[]
for folder in sorted(BASE.glob('DS*-*/v1')):
 dataset=folder.parent.name.split('-')[0]
 shutil.copyfile(BASE/'validate.mjs',folder/'build'/'validate.mjs')
 shutil.copyfile(BASE/'CONTRACT.md',folder/'build'/'CONTRACT.md')
 shutil.copyfile(__file__,folder/'build'/'pack_review.py')
 data=read(folder/'labels'/'construction.json');data['status']='AI_constructed_and_core_setup_validated_author_acceptance_pending';data['coreValidationCommit']=head
 dump(folder/'labels'/'construction.json',data)
 own=[r for r in report['results'] if r['id'].startswith(dataset.lower())]
 dump(folder/'labels'/'static-validation.json',{**{k:v for k,v in report.items() if k!='results'},'cohortScope':'Joint DS11/DS14 deterministic preparation check; results below limited to this dataset','dataset':dataset,'datasetCases':len(own),'results':own})
 sources=[Path(r'D:\AI\Story Dome\新版综合方案')/p for p in ['阶段执行方案/28-P3测试集方案.md','阶段验收标准/29-P3验收标准.md','12-接口设计.md']]+[ROOT/'story/packages/core/src'/p for p in ['schema/index.ts','foundation/index.ts','plan/index.ts','control/index.ts','flow/next.ts','canon/commit.ts']]
 dump(folder/'labels'/'source-pins.json',{'schema':'story/p3-source-pins@1','repositoryCommit':head,'sources':[{'path':str(p),'sha256':sha(p)} for p in sources],'productRulesRead':False,'externalSourceMaterial':False})
 cases=[]
 for ref in read(folder/'acceptance'/'index.json')['cases']:
  p=folder/'acceptance'/ref['path'];s=read(p)
  cases.append({'id':s['id'],'source':{'path':str(p),'sha256':sha(p)},'scenario':s,'review':{'verdict':None,'reason':'','reviewer':'','identity':None,'authorOverallAccepted':False}})
 review={'schema':'story/p3-author-dataset-review@1','date':'2026-11-01','dataset':dataset,'version':'v1','status':'pending_author_review_or_overall_acceptance','constructedBy':'Codex / GPT-6 (AI)','personallyHumanReviewed':False,'count':len(cases),'instructions':'Review every scenario, trigger, acceptable/forbidden actions and all checks; alternatively author overall acceptance under16§3.4. State the actual reviewer identity. No frozen dataset or author approval exists yet.','items':cases}
 rp=REVIEW/f'{dataset}-v1-场景复核.json';dump(rp,review)
 lines=[f'# {dataset} v1 验收场景复核','','状态：待作者逐条核对或整体认可。构造与静态自检：Codex / GPT-6（AI），不称人工复核。',f'共 {len(cases)} 个验收场景。依据28 §5、29 §5，冻结前须完成作者核对或认可。审查重点是触发时点、动作边界及程序/裁判检查是否正确且充分。', '',link('可填写 JSON',rp),'']
 for item in cases:
  s=item['scenario'];lines +=[f'## {s["id"]} — {s["category"]}', '',f'模式：`{s["mode"]}`；'+link('完整场景',Path(item['source']['path'])), '',f'故事提示：{s["storyPrompt"] or "（故意为空：故事提示前的命令测试）"}', '', '准备：']
  for step in s['setup']:
   if step['step']=='open':lines.append(f'- 开书：{len(step["bible"]["items"])} 项设定，{len(step["outline"]["chapters"])} 章大纲，每章目标750词。')
   elif step['step']=='commitChapters':lines.append(f'- 用实际 core 流程及本地替身提交 {step["count"]} 章；原文见完整场景，后续不得回改。')
   else:lines.append('- '+json.dumps(step,ensure_ascii=False))
  lines+=['','触发：`'+json.dumps(s['trigger'],ensure_ascii=False)+'`','','可接受动作：`'+json.dumps(s['expect']['acceptable'],ensure_ascii=False)+'`','','禁止动作：`'+json.dumps(s['expect']['forbidden'],ensure_ascii=False)+'`','','程序检查：']
  lines+=['- '+x for x in s['expect']['programChecks']]
  lines+=['','裁判检查：']+['- '+x for x in (s['expect']['judgeChecks'] or ['无额外语义检查；仍需逐条满足程序检查。'])]
  lines+=['','调度与故障配置：`'+json.dumps(s['execution'],ensure_ascii=False)+'`','','结论：待填写。身份／理由：待填写。','']
 md=REVIEW/f'{dataset}-v1-场景复核.md';md.write_text('\n'.join(lines)+'\n',encoding='utf-8',newline='\n')
 dump(folder/'labels'/'author-review.json',{'schema':'story/p3-review-status@1','status':'pending_author_review_or_overall_acceptance','humanReviewed':False,'authorOverallAccepted':False,'readingCopy':str(md),'form':str(rp),'formSha256':sha(rp),'count':len(cases)})
 # Reproduction commands point at copied sources but always generate a fresh draft output root.
 (folder/'LABELING.md').write_text(f'''# {folder.parent.name} v1 — draft

Identity: Codex / GPT-6, AI construction, labeling and self-check. English synthetic fiction; source requirements: plans28 and29 (2026-11-01). License: AGPL-3.0-only under the repository. No third-party fiction, private material or paid model call was used. Author review and overall acceptance are still pending.

Development and acceptance have different story families. DS11 has15 development and32 acceptance scenarios across A–M; DS14 has5 development variants and15 acceptance cases (10real,5faux). Only this dataset's indexed files are consumed; the totals above describe the paired delivery.

Read build/CONTRACT.md before implementing the driver. The first action, argument paths, negative conditions, timed controls, UI answers, faux profiles, no-gold-in-prompt rule and driver probes are all specified there. A failed observed check is not an inapplicable item. Missing measurements are incomplete, not success.

labels/static-validation.json contains actual offline core preparation results, not P3 product acceptance. The paired67-case validation used114 real core commits and342 local faux role calls, zero paid calls. All source commands and feasible update/patch reference actions were checked. Real RPC/command adapters, auto-continuation, interjection scheduling, U7 retry and model behavior still require the execution session's suites.

Rebuild both datasets into a new ignored draft root from the copied build/build_scenarios.py with --output-root. Then run build/validate.mjs with the paired root and an output JSON path. Do not run the builder into a frozen dataset path. build/pack_review.py is the review packaging source and uses the work-in-progress root; source it only in the data-authoring session, not during development tuning. Scripts contain acceptance definitions and must not be read by developers before acceptance.

This draft has frozenAt:null. J1 development delivery is hash-bound but is not a frozen version. After the author accepts both review sheets, freeze completev1 once and commit only datasets/DS11-*, datasets/DS14-* and the testing index. Old versions, P2 judgments and unrelated work stay unchanged. Future J3 depends on P3 runs and separate author acceptance.
''',encoding='utf-8',newline='\n')
 files=[]
 for p in sorted(folder.rglob('*')):
  if not p.is_file() or p.name=='manifest.json':continue
  rel=p.relative_to(folder).as_posix();split='dev' if rel.startswith('dev/') else 'acceptance' if rel.startswith('acceptance/') else 'shared'
  files.append({'path':rel,'sha256':sha(p),'source':'Original AI-constructed P3 scenario or its construction/review metadata; source requirements pinned in labels/source-pins.json','license':'AGPL-3.0-only','split':split})
 dump(folder/'manifest.json',{'schema':'story/dataset-manifest@1','id':dataset,'version':'v1','frozenAt':None,'state':'draft_author_acceptance_pending','annotationStatus':'AI_constructed_AI_labeled_core_setup_validated_author_acceptance_pending','files':files})
 allrefs.append({'dataset':dataset,'folder':str(folder),'manifestSha256':sha(folder/'manifest.json'),'reviewReading':str(md),'reviewForm':str(rp)})
 for p in sorted((folder/'dev').glob('*.json')):devrefs.append({'dataset':dataset,'path':str(p),'sha256':sha(p)})
 devrefs.append({'dataset':dataset,'path':str(folder/'build'/'CONTRACT.md'),'sha256':sha(folder/'build'/'CONTRACT.md')})
dump(BASE/'J1-development-handoff.json',{'schema':'story/p3-development-handoff@1','date':'2026-11-01','status':'development_draft_delivered_J1','DS11Cases':15,'DS14Cases':5,'frozen':False,'files':devrefs,'readPolicy':'Only the listed dev files and contract. Do not read acceptance, author review sheets or generator source while tuning.','laterFreeze':'Completev1 freezes once after author acceptance; development bytes will be checked against these pins.'})
j1=REVIEW/'P3-J1-开发集交付.md'
j1.write_text('''# P3 J1 开发集交付

2026-11-01。DS11开发15场景、DS14开发5变体已准备好，供27 S9实现测量工具及S10开发。当前是带摘要的开发草稿，完整v1待验收清单获认可后一次冻结，避免以后追加修改冻结版本。

'''+ '\n'.join(f'- {link(d+" 开发索引",BASE/name/"v1/dev/index.json")}' for d,name in [('DS11','DS11-showrunner-scenarios'),('DS14','DS14-author-control-e2e')])+ '\n\n'+link('开发交付摘要',BASE/'J1-development-handoff.json')+'；'+link('场景格式与执行约定',BASE/'DS11-showrunner-scenarios/v1/build/CONTRACT.md')+'''

只读dev文件及格式约定。验收目录、完整复核表和生成器源码含验收内容，调试阶段勿读。准备段通过真实core流程、本地替身验证；P3动态调度与产品行为尚未运行。没有付费调用。

参数约定：open使用core输入；patch_outline用12§3.3的chapters；/budget的usd映射为costUsd；continue不是新作者消息；命令不复制造成普通作者消息。execution补充事件定位、顺序后续动作、对话框答案和替身故障脚本。详细可运行前置状态及边界均见格式约定。
''',encoding='utf-8',newline='\n')
dump(BASE/'delivery.json',{'schema':'story/p3-dataset-draft-delivery@1','date':'2026-11-01','status':'J1_ready_J2_draft_pending_author_acceptance','datasets':allrefs,'J1':{'readingCopy':str(j1),'sha256':sha(j1),'developmentPins':str(BASE/'J1-development-handoff.json')},'validation':{'path':str(BASE/'static-validation.json'),'sha256':sha(BASE/'static-validation.json'),'cases':67,'commits':114,'fauxCalls':342,'measurementExecuted':False},'authorAcceptanceRequired':True,'paidModelCalls':0,'committed':False})
print(json.dumps({'J1':str(j1),'reviews':allrefs,'status':'pending_author_acceptance'},ensure_ascii=False))
