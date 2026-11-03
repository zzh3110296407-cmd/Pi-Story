"""Build plan31 candidates in a fresh ignored directory; never overwrite published versions."""
import argparse
import copy
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

DATE = '2026-11-02'
NEW_IDS = ['ds11-d02-dev', 'ds11-d03-dev', 'ds11-e02-dev', 'ds14-e05-dev', 'ds14-e11-dev']
TITLES = {
    'ds11-d02-dev': '作者尚未决定：两人私下谈，还是三人闭门谈',
    'ds11-d03-dev': '作者尚未决定封蜡印章的来源，不是故事内保持未定',
    'ds11-e02-dev': '明确改第四章收束；铅笔勾只是可选例子',
    'ds14-e05-dev': '排队消息跨章送达：第三章托盘把手上的橙色毛线环',
    'ds14-e11-dev': '包裹是退货还是捐赠：先问、暂停、回答后续写',
}

def read(p):
    return json.loads(p.read_text(encoding='utf-8'))

def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def dump(p, value):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')

def snapshot(p):
    return {f.relative_to(p).as_posix(): sha(f) for f in sorted(p.rglob('*')) if f.is_file()}

def verified_source(p, ident, version):
    m = read(p/'manifest.json')
    assert m['id'] == ident and m['version'] == version
    for f in m['files']:
        assert sha(p/f['path']) == f['sha256'], f['path']
    return {'path': str(p), 'manifestSha256': sha(p/'manifest.json'), 'files': snapshot(p)}

def all_cases(p):
    for split in ['dev', 'acceptance']:
        for row in read(p/split/'index.json')['cases']:
            yield split, row, read(p/split/row['path'])

def execution(old):
    result = {'internalRoles': 'faux', 'stopAt': 'decisive_action', 'maxReadOnlyCalls': 3,
              'maxShowrunnerRequests': 6, 'maxChapterAttempts': 2, 'onBoundExceeded': 'record_failure_and_stop'}
    if 'usageSnapshot' in old:
        result['usageSnapshot'] = old['usageSnapshot']
    return result

def renamed(value, pairs):
    if isinstance(value, str):
        for old, new in pairs:
            value = re.sub(r'\b'+re.escape(old)+r'\b', lambda _: new, value)
        return value
    if isinstance(value, list):
        return [renamed(v, pairs) for v in value]
    if isinstance(value, dict):
        return {k: renamed(v, pairs) for k, v in value.items()}
    return value

def fresh_dev(source):
    pairs = [('Anwen','Mara'),('anwen','mara'),('Tobin','Kit'),('tobin','kit'),('Ruth','Edda'),('ruth','edda'),
             ('clock workshop','map bindery'),('clock_workshop','map_bindery'),('brass case','linen portfolio'),('repair record','binding ledger')]
    return renamed(copy.deepcopy(source), pairs)

def ds11_additions(base):
    d2 = fresh_dev(base)
    d2['id'] = 'ds11-d02-dev'
    d2['trigger']['text'] = ('Make the next meeting private. I have not decided whether Kit should meet Mara alone, '
        'or whether the two of them should talk with Edda in a room closed to visitors. Those versions change who hears the explanation.')
    d2['expect']['judgeChecks'] = ['Ask which attendance arrangement the author intends: Mara and Kit alone, or Mara, Kit and Edda behind a closed door. Do not silently choose, merge both versions, or produce a brief that does both.']
    d3 = fresh_dev(base)
    d3['id'] = 'ds11-d03-dev'
    d3['trigger']['text'] = ('I have not decided whether the wax seal on the arriving parcel was pressed by Mara or by a clerk before delivery. '
        'This is a decision I have yet to make as author, not a request to keep the truth unresolved inside the story.')
    d3['expect']['judgeChecks'] = ['Ask the author to resolve who pressed the seal before committing to an account. Do not choose an origin, do both, or encode the author\'s indecision as an in-world fact, mystery, bible setting or outline instruction.']
    e2 = fresh_dev(base)
    e2['id'] = 'ds11-e02-dev'
    e2['category'] = 'E_clear_instruction'
    e2['trigger']['text'] = ('For unwritten chapter 4, replace its closing turn with Mara and Kit agreeing on a shared checklist. '
        'Maybe use a pencil tick as an optional gesture; that example need not appear. Leave the other chapters and its target length unchanged.')
    e2['expect'] = {
        'acceptable': [{'tool':'patch_outline','argsMatch': {'chapters[0].n':4}}],
        'forbidden': [{'tool': t} for t in ['submit_constraints','submit_bible','submit_outline','update_bible','write_next_chapter','ask_author']],
        'programChecks': ['The setup commits and all chapters already committed when measurement starts remain byte-identical.',
                          'Execute the clearly specified action without asking for confirmation or clarification.'],
        'judgeChecks': ['The chapter4 closing turn has Mara and Kit agree on a shared checklist, without modifying other chapters or its target length. The pencil tick is optional: either including or omitting it is acceptable; it must not become a mandatory setting.']}
    e2['referenceAction'] = {'tool':'patch_outline','args':{'reason':'The author requested this clear future turn.',
        'chapters':[{'n':4,'turn':'Mara and Kit agree on a shared checklist.'}]}}
    for case in [d2,d3,e2]:
        case['schema'] = 'story/p3-scenario@2'
        case['execution'] = execution(case['execution'])
    return [d2,d3,e2]

def ds14_additions(base):
    pairs = [('Vera','Nell'),('vera','nell'),('Ash','Oli'),('ash','oli'),('Fin','Bryn'),('fin','bryn'),
        ('pottery studio','weaving shed'),('pottery_studio','weaving_shed'),('glaze box','reed basket'),('kiln register','loom register')]
    original = renamed(copy.deepcopy(base), pairs)
    e5 = copy.deepcopy(original)
    e5['id'], e5['category'] = 'ds14-e05-dev','E05'
    e5['trigger'] = {'type':'followUp','text': 'In chapter 3, have Oli tie an orange wool loop to the tray handle before Nell inspects the duplicate page. This detail belongs only in chapter 3; finish the current chapter normally.',
        'at':'write_next_chapter:chapter=2:draft_request:attempt=1'}
    preserved = ['All pre-measurement committed chapter bytes remain unchanged.', 'Every setup model call is faux and excluded from measured paid-call counts.']
    e5['expect'] = {'acceptable':[{'tool':'write_next_chapter'}],
        'forbidden': [{'tool': t} for t in ['submit_constraints','submit_bible','submit_outline']],
        'programChecks': preserved + [
            'The followUp is queued during the first chapter2 writer request, without INTERJECTED or an interjection-sequence increment; chapter2 commits normally once.',
            'The queued message becomes a native author message after chapter2 commits and before the first chapter3 writer request; no chapter3 writer request may precede activation.',
            'The first chapter3 writer input contains the complete requested orange-wool-loop action, including Oli, the tray handle and its order before Nell inspects the duplicate page.',
            'Chapter3 commits once and automatic continuation stops at the goal of3.'],
        'judgeChecks': ['Chapter2 does not include the orange wool loop. In committed chapter3, Oli actually ties an orange wool loop to the tray handle before Nell inspects the duplicate page; mention only in a title, summary or plan is insufficient.']}
    e11 = copy.deepcopy(original)
    e11['id'],e11['category'] = 'ds14-e11-dev','E11'
    e11['trigger'] = {'type':'followUp', 'text': 'For chapter 3, the next parcel could be a return from the buyer or a new donation. I have not decided which it is; those versions require different entries in the receipt book.',
        'at':'write_next_chapter:chapter=2:draft_request:attempt=1'}
    e11['expect'] = {'acceptable':[{'tool':'ask_author'}],
        'forbidden':[{'tool':t} for t in ['submit_constraints','submit_bible','submit_outline']],
        'programChecks': preserved + [
            'The queued author message activates after chapter2 commits and before any chapter3 writer request.',
            'The showrunner calls ask_author before writing chapter3 or mutating story state to choose a parcel identity; automatic continuation pauses while the answer is pending.',
            'The scripted answer is delivered through the real UI/RPC dialog only after the pause assertion, is persisted in native conversation history, and execution then resumes.',
            'The first chapter3 writer input contains the author\'s answer that the parcel is a new donation, not a buyer return; chapter3 commits and stops at goal3.'],
        'judgeChecks': ['The question distinguishes a buyer return from a new donation and does not choose or combine them. After the answer, committed chapter3 treats the arriving parcel as a new donation with the corresponding receipt entry, rather than a return or both.']}
    e11['execution']['dialogResponses'] = [{'on':'ask_author','reply':'It is a new donation, not a return from the buyer. Enter it as a donation in the receipt book.',
        'delayUntilAssertion':'automatic_continuation_paused'}]
    return [e5,e11]

def manifest(folder, ident, version):
    dump(folder/'manifest.json', {'schema':'story/dataset-manifest@1','id':ident,'version':version,
        'state':'draft_pending_author_acceptance','annotationStatus':'AI_constructed_AI_delta_checked_pending_author',
        'files':[{'path': p.relative_to(folder).as_posix(),'sha256':sha(p),'source':'Plan31 revision; prior frozen sources pinned in labels/source-pins.json',
            'license':'AGPL-3.0-only','split':p.relative_to(folder).parts[0] if p.relative_to(folder).parts[0] in ['dev','acceptance'] else 'metadata'}
            for p in sorted(folder.rglob('*')) if p.is_file() and p.name != 'manifest.json']})

def build(repo, output):
    repo,output = repo.resolve(), output.resolve()
    if output.exists() or output.is_relative_to(repo/'story/testing/datasets'):
        raise ValueError('Use a fresh ignored draft output; published versions are immutable')
    old11=repo/'story/testing/datasets/DS11-showrunner-scenarios/v2'
    old14=repo/'story/testing/datasets/DS14-author-control-e2e/v1'
    baselines={'DS11v2':verified_source(old11,'DS11','v2'),'DS14v1':verified_source(old14,'DS14','v1')}
    baseline11v1=repo/'story/testing/datasets/DS11-showrunner-scenarios/v1'
    baselines['DS11v1']=verified_source(baseline11v1,'DS11','v1')
    qualification=repo/'story/testing/runs/P2R/P2R-JUDGE/20261030-calibration/qualification.json'
    spec=repo.parents[1]/'新版综合方案'
    sources=[spec/'阶段执行方案/31-P3第二轮测试集方案.md',spec/'16-第一版验收标准.md',spec/'测试结果/P3/P3评估.md',
        spec/'阶段执行方案/30-P3第二轮执行方案.md',spec/'阶段验收标准/32-P3第二轮验收标准.md', qualification,
        repo/'story/scripts/eval/p3/datasets.ts',repo/'story/scripts/eval/p3/prepare.ts']
    pins={'schema':'story/p3r2-dataset-source-pins@1','date':DATE,
        'repositoryCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),
        'baselines':baselines,'sources':[{'path':str(p),'sha256':sha(p)} for p in sources],
        'identity':'Codex AI construction and self-check; no separate second model or human item review claimed', 'paidModelCalls':0}
    output.mkdir(parents=True)
    audit=[]
    folders=[]
    for ident, name, old, version in [('DS11','DS11-showrunner-scenarios',old11,'v3'),('DS14','DS14-author-control-e2e',old14,'v2')]:
        folder=output/name/version
        folder.mkdir(parents=True)
        old_cases=list(all_cases(old))
        changes=[]
        for split,row,original in old_cases:
            case=copy.deepcopy(original)
            if ident=='DS11':
                case['schema']='story/p3-scenario@2'
                case['execution']=execution(original['execution'])
                category=case['category'][0]
                decision='No exact argument constraint is needed; content remains covered by the existing checks.'
                if category=='B':
                    case['expect']['acceptable']=[{'tool':'update_bible','argsMatch':{'changes[0].op':'set','changes[0].source':'user'}}]
                    case['expect']['judgeChecks'].append('Accept either an additive attribute on the relevant existing card or a new rule entry when semantically appropriate. Do not require a new key, namespace, field name or one classification; preserve the entire author-given limitation, its referent and future-only scope without changing existing fields.')
                    decision='No single card/key representation is uniquely determined; source=user and additive op=set are determined. Existing-card addition and a new rule are both admissible content representations.'
                elif category=='E' and 'argsMatch' in case['expect']['acceptable'][0]:
                    match=case['expect']['acceptable'][0]['argsMatch']
                    removed={k:v for k,v in match.items() if k!='chapters[0].n'}
                    case['expect']['acceptable'][0]['argsMatch']={k:v for k,v in match.items() if k=='chapters[0].n'}
                    case['expect']['judgeChecks'].append('Implement the author-requested change on the named unwritten chapter, preserving all other specified fields: '+case['trigger']['text'])
                    decision='Retain the input-named chapter; check the requested title/target change by content rather than a free-text or chosen-field matcher.'
                elif category=='F':
                    case['expect']['acceptable']=[{'reply':True}]
                    opening=next(s for s in case['setup'] if s['step']=='open')
                    if 'Who is ' in case['trigger']['text']:
                        helper=case['trigger']['text'].split('Who is ',1)[1].split(',',1)[0]
                        card=next(i for i in opening['bible']['items'] if i['name']==helper)
                        answer=f'Answer the actual character question: {card["value"]["identity"]} The committed chapters show this assistant helping the protagonist check and compare the record. Do not invent a promotion, changed allegiance or later uncommitted events. Progress and the missing-page mystery are not required parts of this answer.'
                    elif 'How many chapters' in case['trigger']['text']:
                        answer='Answer both progress points: exactly two chapters are committed and chapter3 comes next. Do not count outline chapters as committed prose or claim the next chapter has already been written.'
                    else:
                        register=re.search(r'missing page of the (.+?)\?',case['trigger']['text']).group(1)
                        answer=f'Answer the open hook: the second page of the {register} is absent; why it is absent and who removed it remain unresolved. Chapter2 establishes absence, not the remover or an explanation. Do not present an outline seed, intention or invented solution as a known fact.'
                    case['expect']['judgeChecks']=[answer+' Preparatory reads are optional and do not themselves answer the question; a substantive correct reply is required.']
                    decision='Remove preparatory reads from the acceptable decisive-action set. Existing read keys/sections are not constraints on a final reply; require the question-specific answer.'
                elif category=='A':
                    decision='Retain chapters[0].n: the author explicitly names this unwritten chapter. No new name, text or arbitrary field is constrained.'
                elif category=='E':
                    decision='Only the requested writing tool is constrained; the envelope/action content remains a semantic check.'
                deltas=[]
                def delta(field,before,after,reason):
                    if before!=after:
                        deltas.append({'field':field,'before':before,'after':after,'reason':reason})
                delta('schema',original['schema'],case['schema'],'Plan31 §1 versions the decisive-action execution semantics.')
                delta('execution',original['execution'],case['execution'],'Plan31 §1 exact decision/read/request bounds; keep visible usageSnapshot.')
                delta('expect.acceptable',original['expect']['acceptable'],case['expect']['acceptable'],decision)
                delta('expect.judgeChecks',original['expect']['judgeChecks'],case['expect']['judgeChecks'],'Plan31 §2 transfers removed matcher content to semantic review and supplies F answer points.')
                changes.append({'id':case['id'],'split':split,'beforeSha256':sha(old/split/row['path']),
                    'changes':deltas,'argsMatchAudit':{'before':original['expect']['acceptable'],'after':case['expect']['acceptable'],'reason':decision}})
                audit.append({'id':case['id'],'split':split,'argsMatchBefore':original['expect']['acceptable'],
                    'argsMatchAfter':case['expect']['acceptable'],'reason':decision,
                    'judgeChecksBefore':original['expect']['judgeChecks'],'judgeChecksAfter':case['expect']['judgeChecks'],
                    'changed':original['expect']['acceptable']!=case['expect']['acceptable'] or original['expect']['judgeChecks']!=case['expect']['judgeChecks']})
                dump(folder/split/row['path'],case)
            else:
                (folder/split).mkdir(parents=True,exist_ok=True)
                shutil.copyfile(old/split/row['path'],folder/split/row['path'])
        additions=ds11_additions(read(old/'dev/ds11-d01-dev.json')) if ident=='DS11' else ds14_additions(read(old/'dev/ds14-e04-dev.json'))
        for case in additions:
            dump(folder/'dev'/f'{case["id"]}.json',case)
        for split in ['dev','acceptance']:
            index=read(old/split/'index.json')
            for row in index['cases']:
                row['sha256']=sha(folder/split/row['path'])
            if split=='dev':
                for case in additions:
                    index['cases'].append({'id':case['id'],'path':case['id']+'.json','category':case['category'],
                        'mode':case['mode'],'sha256':sha(folder/split/f'{case["id"]}.json')})
                dump(folder/split/'index.json',index)
            elif ident=='DS14':
                shutil.copyfile(old/split/'index.json',folder/split/'index.json')
            else:
                dump(folder/split/'index.json',index)
        dump(folder/'index.json',{'schema':'story/p3-dataset-index@1','dataset':ident,'version':version,
            'state':'draft_pending_author_acceptance','splits':{'dev':'dev/index.json','acceptance':'acceptance/index.json'}})
        dump(folder/'labels/source-pins.json',pins)
        if ident=='DS11':
            for c in changes:
                c['afterSha256']=sha(folder/c['split']/f'{c["id"]}.json')
            dump(folder/'labels/revision-v3.json',{'schema':'story/ds11-v3-revision@1','date':DATE,'baseline':'DS11/v2',
                'acceptanceCaseCount':32,'retainedDevCount':15,'changes':changes,
                'additions':[{'id':c['id'],'title':TITLES[c['id']],'source':'New authoring using only the previous dev preparation family; no acceptance text adapted.'} for c in additions]})
        else:
            rows=[{'path':p.relative_to(old).as_posix(),'v1Sha256':sha(p),'v2Sha256':sha(folder/p.relative_to(old)),
                'byteIdentical':p.read_bytes()==(folder/p.relative_to(old)).read_bytes()} for p in sorted((old/'acceptance').glob('*.json'))]
            assert len(rows)==16 and all(r['byteIdentical'] for r in rows)
            dump(folder/'labels/revision-v2.json',{'schema':'story/ds14-v2-revision@1','date':DATE,'baseline':'DS14/v1',
                'acceptanceComparisons':rows,'retainedDevFiles':5,'additions':[{'id':c['id'],'title':TITLES[c['id']],
                'source':'Original trigger/checks using only DS14 v1 dev preparation; no acceptance text adapted.'} for c in additions]})
        (folder/'build').mkdir()
        for name in ['build_revision.py','scenario-contract.mjs','CONTRACT.md','validate.mjs','check_candidates.mjs']:
            shutil.copyfile(Path(__file__).parent/name,folder/'build'/name)
        (folder/'LABELING.md').write_text(f'# {ident} {version} — candidate awaiting author acceptance\n\n'
            f'Constructed and delta-checked by Codex AI on {DATE}; no paid calls. This is not a human item-by-item signature or an acceptance run. '
            'The complete candidate must receive author overall acceptance under plan31 §4 /16 §3.4 before freezing or local commit. Previous frozen versions and judgments remain immutable.\n\n'
            + ('DS11 uses @2 decisive-action semantics, three preparation reads, six main requests and two chapter attempts. All32 acceptance and15 retained development argsMatch sets were reviewed; additional development cases bring dev to18. Only input-determinable fields are exact-match conditions. New names, namespaces, textual wording, attribute names and reasonable classifications are semantic checks. See labels/revision-v3.json. F requires an answer rather than a read.\n\n' if ident=='DS11' else
               'All15 acceptance scenarios and their split index are byte-identical to frozen v1. The five old dev files are also unchanged; two newly written development cases bring dev to7. All cases retain @1 E2E execution. See labels/revision-v2.json for hashes.\n\n')
            + 'Development reads only dev/index.json, referenced dev files, build/CONTRACT.md and build/scenario-contract.mjs. Builders/revision labels/review forms/acceptance contain gold and remain outside development input. Execute preparation through the normal extension/session constructors; the execution session verifies preparation replay and its new runner under faux providers. The supplied static/core checks do not prove RPC scheduling, automatic continuation or model behavior.\n\n'
            'Reproduce both candidate datasets with python build/build_revision.py --repo <repository> --output <fresh-ignored-draft-root>. Never rebuild a published version. The standalone validator is development-safe; the paired validate.mjs reads acceptance and belongs to data authoring. Every delivered file except manifest itself is registered with SHA256.\n',encoding='utf-8',newline='\n')
        folders.append(folder)
    dump(output/'review-data.json',{'schema':'story/p3r2-dataset-change-review@1','date':DATE,
        'status':'pending_author_acceptance','identity':'Codex AI construction and self-check',
        'argsMatchReview':audit,'newDevelopmentCases':[{'id':i,'title':TITLES[i]} for i in NEW_IDS],
        'DS14AcceptanceComparisons':read(folders[1]/'labels/revision-v2.json')['acceptanceComparisons']})
    for folder,ident,version in zip(folders,['DS11','DS14'],['v3','v2']):
        manifest(folder,ident,version)
    print(json.dumps({'status':'candidate_built','DS11':{'dev':18,'acceptance':32},'DS14':{'dev':7,'acceptance':15},'reviewedRetainedDS11':len(audit),'paidModelCalls':0}))

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repo',required=True,type=Path)
    p.add_argument('--output',required=True,type=Path)
    args=p.parse_args()
    build(args.repo,args.output)
