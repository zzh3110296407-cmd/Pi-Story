import argparse,copy,hashlib,json,re,shutil
from pathlib import Path
ROOT=next(p for p in Path(__file__).resolve().parents if (p/'story/package.json').exists())
parser=argparse.ArgumentParser()
parser.add_argument('--output-root',type=Path,default=ROOT/'story/testing/drafts/P3-rebuild')
BASE=parser.parse_args().output_root.resolve()
NAMES={'DS11':'DS11-showrunner-scenarios','DS14':'DS14-author-control-e2e'}
THEMES={
 'dev':[('Anwen','Tobin','Ruth','clock workshop','clock_workshop','brass case','repair record'),('Orla','Dex','Mina','seed library','seed_library','seed tin','loan register'),('Ivo','Hana','Ben','ferry office','ferry_office','chart tube','crossing record')],
 'acceptance':[('Lena','Oren','Suri','tram museum','tram_museum','sample case','service register'),('Pema','Cal','Eli','salt archive','salt_archive','wax packet','tide register'),('Nadi','Wren','Sol','kite hall','kite_hall','wooden sleeve','flight register')],
 'e2edev':[('Vera','Ash','Fin','pottery studio','pottery_studio','glaze box','kiln register')],
 'e2eacceptance':[('Aster','Jo','Kei','canopy station','canopy_station','seed capsule','canopy register')]
}
def dump(p,x):
 p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
def past(text):
 verbs={'receives':'received','checks':'checked','notices':'noticed','leaves':'left','compare':'compared','establish':'established','is':'was','defer':'deferred','reads':'read','asks':'asked','supplies':'supplied','agrees':'agreed','prepares':'prepared','identifies':'identified','agree':'agreed','completes':'completed','files':'filed','credits':'credited','obtains':'obtained','finish':'finished','store':'stored','ends':'ended'}
 return re.sub(r'\b('+'|'.join(verbs)+r')\b',lambda m:verbs[m.group(0)],text)
def foundation(split,i=0,e2e=False):
 pool=THEMES['e2e'+('dev' if split=='dev' else 'acceptance')] if e2e else THEMES[split]
 a,b,c,place,slug,item,record=pool[i%len(pool)]
 key=lambda s:s.lower().replace(' ','_')
 clauses=[f'{a} is a practical conservator.',f'{b} is an assistant who is allowed to disagree.',f'{c} keeps the public records.',f'The story takes place at the {place}.',f'The {item} must remain intact.', 'No character may be physically injured.', 'Keep practical actions precise.']
 prompt='Write a quiet English story about checking a disputed delivery before a public demonstration. '+' '.join(clauses)+f' Use third-person past tense centred on {a}. Plan '+('three' if e2e else 'six')+' chapters, each targeting 750 words. No earlier book or borrowed fictional world is assumed.'
 bible=[]
 for name,quote in zip([a,b,c],clauses[:3]):bible.append({'kind':'character','key':'char:'+key(name),'name':name,'source':'user','authorQuote':quote,'value':{'identity':quote}})
 bible.extend([{'kind':'place','key':'place:'+slug,'name':place,'source':'user','authorQuote':clauses[3],'value':{'description':clauses[3]}},{'kind':'rule','key':'rule:care','name':'Careful handling','source':'user','authorQuote':clauses[4],'value':{'description':clauses[4],'invariants':[clauses[4]]}}])
 beats=[(f'{a} receives the sealed {item} and checks its outer label.',f'{a} notices a red seam but leaves it unopened.'),(f'{a} and {b} compare the label with the {record}.',f'They establish that the second page is absent and defer opening the {item}.'),(f'{a} reads the handling note and asks {c} about the missing page.',f'{c} supplies a duplicate page; the team agrees to continue checking before a demonstration.'),(f'{a} compares the duplicate with a pencil copy.',f'{b} identifies a transposed line and they agree on a corrected label.'),(f'The team prepares the public demonstration at the {place}.',f'{a} credits {b} for finding the error, without claiming the item was lost.'),(f'{a} completes the demonstration and files the corrected {record}.',f'The intact {item} is stored securely and the dispute is closed.')]
 if e2e:beats[2]=(f'{a} reads the handling note and obtains the duplicate page from {c}.',f'They finish the small demonstration and store the intact {item}; the delivery dispute ends.')
 outline={'narration':{'viewpoint':f'Third-person limited through {a}','tone':'Quiet, practical and humane','format':'English prose'},'chapters':[{'n':n,'title':['Arrival','Comparison','The Duplicate','The Copy','Demonstration','Storage'][n-1],'targetWords':750,'purpose':p,'turn':t,'hookSeeds':[f'Who removed the second page of the {record}?'] if n==1 else []} for n,(p,t) in enumerate(beats[:3 if e2e else 6],1)]}
 texts=[]
 for n,(p,t) in enumerate(beats[:3 if e2e else 6],1):
  texts.append(f'''{past(p)} The {place} was open, though there were no visitors at the table. {a} cleared a space before setting anything down. {b} moved the loose tools to a tray and waited for instructions. Neither of them treated a late delivery as proof of a lost object. They checked what they could see and left a blank beside what they could not yet establish.

The work required a little patience. A faded number was difficult to distinguish from a stain, so {a} turned the sheet towards the window rather than writing over it. {b} read the number aloud. They compared their readings, found that they agreed, and entered it only once. The {item} remained intact on the cleared table throughout the check.

{a} made a short note of the work completed that day. The note separated observation from intention: a task written for tomorrow did not become a task already done. {b} asked whether the uncertainty meant they should abandon the demonstration. {a} said that an unanswered question was a reason to check, rather than a reason to invent an answer. It was an ordinary distinction, but making it aloud helped them continue without blaming anyone.

{past(t)} They put the tools back in the tray. {a} recorded that result and closed the current work period. The next planned task remained unwritten in the story. No one had opened a different room, visited another site, or completed the later demonstration in the interval between these actions.''')
 constraints={'op':'submit','items':[{'kind':'global','text':clauses[5],'quotes':[clauses[5]]},{'kind':'story','text':clauses[4],'quotes':[clauses[4]]},{'kind':'global','text':clauses[6],'quotes':[clauses[6]]}]}
 return {'a':a,'b':b,'c':c,'place':place,'slug':slug,'item':item,'record':record,'char':'char:'+key(a),'prompt':prompt,'constraints':constraints,'bible':{'items':bible},'outline':outline,'texts':texts}
def initial(f,count=2):
 steps=[{'step':'open','constraints':f['constraints'],'bible':f['bible'],'outline':f['outline']}]
 if count:
  keeper_hooks=[[] for _ in range(count)]
  if count>=2:keeper_hooks[1]=[{'ref':'missing_page','op':'upsert','type':'mystery','expectedPayoff':f'Why is the second page of the {f["record"]} absent?','evidenceText':past(f'They establish that the second page is absent and defer opening the {f["item"]}.')}]
  steps.append({'step':'commitChapters','count':count,'texts':f['texts'][:count],'keeperHooks':keeper_hooks})
 return steps
def action(tool,match=None):return {'tool':tool,**({'argsMatch':match} if match else {})}
def scenario(id,split,category,f,count=2,mode='real'):
 return {'schema':'story/p3-scenario@1','id':id,'split':split,'category':category,'storyPrompt':f['prompt'],'setup':initial(f,count),'trigger':{'type':'authorMessage','text':''},'expect':{'acceptable':[],'forbidden':[],'programChecks':[],'judgeChecks':[]},'mode':mode,'execution':{'internalRoles':'faux' if id.startswith('ds11') or mode=='faux' else 'real','maxShowrunnerRequests':4,'maxChapterAttempts':2,'stopAfterFirstAction':id.startswith('ds11'),'onBoundExceeded':'record_failure_and_stop'}}
WRITES=['submit_constraints','submit_bible','submit_outline','update_bible','patch_outline','write_next_chapter']
def forbid_except(*allowed):return [action(t) for t in WRITES if t not in allowed]
def error_step(tool,args,code,message,items=None,hint=None):
 e={'code':code,'message':message,**({'items':items} if items else {}),**({'hint':hint} if hint else {})}
 return {'step':'toolCall','tool':tool,'args':args,'result':{'ok':False,'error':e}}
COUNTS={'A':3,'B':3,'C':2,'D':3,'E':3,'F':3,'G':4,'H':2,'I':2,'J':2,'K':2,'L':2,'M':1}
CATEGORIES={'A':'change_unwritten_outline','B':'add_future_setting','C':'change_committed_content','D':'material_ambiguity','E':'clear_instruction','F':'story_question','G':'repairable_tool_error','H':'budget_exhausted','I':'goal_reached','J':'immediate_interjection','K':'control_notice','L':'two_failures','M':'cost_question'}
def ds11_case(split,cat,n):
 f=foundation(split,(ord(cat)-65+n-1)%3);a,b,c=f['a'],f['b'],f['c'];count=2
 if cat=='I':count=3
 s=scenario(f'ds11-{cat.lower()}{n:02}'+('-dev' if split=='dev' else ''),split,cat+'_'+CATEGORIES[cat],f,count)
 x=s['expect'];x['forbidden']=forbid_except();x['programChecks']=['The setup commits and all chapters already committed when measurement starts remain byte-identical.']
 if cat=='A':
  chapter=[3,4,5][n-1];purpose=[f'{b} leads the document check while {a} assists.',f'Compare the pencil copy outdoors at the same site.',f'Run the demonstration without an audience and keep a written record.'][n-1]
  text=f'Change only the unwritten chapter {chapter}: {purpose} Keep its chapter number and the existing chapter count. Do not rewrite earlier chapters.'
  s['trigger']['text']=text;x['acceptable']=[action('patch_outline',{'chapters[0].n':chapter})];x['forbidden']=forbid_except('patch_outline')+[action('ask_author')]
  x['programChecks']+=['The first action is patch_outline, with a nonempty reason; only the named unwritten chapter changes.','The chapter numbers remain contiguous; no new author control entry is written.']
  x['judgeChecks']=[f'The patch implements this requested event change rather than merely renaming the chapter: {purpose}']
  s['referenceAction']={'tool':'patch_outline','args':{'reason':'The author requested this change to an unwritten chapter.','chapters':[{'n':chapter,'purpose':purpose}]}}
 elif cat=='B':
  if n==1:key=f['char'];value={'abilities':'Can decode semaphore, but only in daylight.'};addition=f'From the next chapter onward, {a} can decode semaphore, but only in daylight.'
  elif n==2:key='place:'+f['slug'];value={'access':'Carts may enter only through the west door.'};addition=f'For future scenes, carts may enter the {f["place"]} only through the west door.'
  else:key='rule:dry_copy';value={'description':'A damp paper copy must dry flat before anyone turns its pages.'};addition='For future scenes, a damp paper copy must dry flat before anyone turns its pages.'
  s['trigger']['text']=addition+' Add this as a future setting; keep all existing descriptions and committed events unchanged.'
  x['acceptable']=[action('update_bible',{'changes[0].key':key,'changes[0].op':'set','changes[0].source':'user'})];x['forbidden']=forbid_except('update_bible')+[action('ask_author')]
  x['programChecks']+=['A nonempty reason and an exact quote from the latest author message are supplied.','The resulting bible revision becomes effective at chapter 3; no prior effective revision or existing field is rewritten.']
  x['judgeChecks']=[f'The new field or new rule preserves the entire limitation, without broadening it: {addition}']
  s['referenceAction']={'tool':'update_bible','args':{'reason':'The author supplied a future-only addition.','changes':[{'kind':'character' if n==1 else 'place' if n==2 else 'rule','key':key,'source':'user','authorQuote':addition,'op':'set','value':value}]}}
 elif cat=='C':
  chapter=n;text=f'Please replace committed chapter {chapter}: make {a} hand the {f["item"]} to {b} there, instead of keeping it on the table. I mean the existing prose, not a later recollection.'
  s['trigger']['text']=text;x['acceptable']=[{'reply':True}]
  x['programChecks']+=['No writing tool is called and no current-branch entries or chapter text are changed.']
  x['judgeChecks']=[f'Explain that committed chapter {chapter} cannot be edited in place in P3. A rewrite requires a branch before chapter {chapter}; /branch-from is a P4 capability, not an available P3 action. Do not claim the edit was performed.']
 elif cat=='D':
  text=['Make the next scene lighter. I have not decided whether I mean the lighting or the emotional tone.','Change the ending to favour her. Both women are still under consideration, and I have not chosen which one.','Let the missing page be a copy. I have not decided whether it is a harmless duplicate or a forged replacement.'][n-1]
  if n==2:text=f'Change the ending to favour {a} or {b}; I have not decided which of them should receive the credit.'
  s['trigger']['text']=text;x['acceptable']=[action('ask_author')]
  x['judgeChecks']=['The question distinguishes the material alternatives in the author request. It does not ask for an unrelated stylistic preference or silently choose an interpretation.']
  x['programChecks']+=['No story mutation precedes ask_author; question is nonempty.']
 elif cat=='E':
  if n==1:
   s['trigger']['text']='Set the title of unwritten chapter 3 to The Duplicate Page. Leave its events, number and target length unchanged.';x['acceptable']=[action('patch_outline',{'chapters[0].n':3,'chapters[0].title':'The Duplicate Page'})]
   s['referenceAction']={'tool':'patch_outline','args':{'reason':'The author requested this exact title.','chapters':[{'n':3,'title':'The Duplicate Page'}]}}
  elif n==2:
   s['trigger']['text']='Write chapter 3 now. Follow its existing plan, and make the duplicate page arrive in a plain envelope. This is a new action in chapter 3, not a change to chapter 2.';x['acceptable']=[action('write_next_chapter')];x['judgeChecks']=['The brief includes the plain envelope and preserves the next-chapter sequence.']
  else:
   s['trigger']['text']='For unwritten chapter 4, set targetWords to 800. Keep all other outline fields unchanged.';x['acceptable']=[action('patch_outline',{'chapters[0].n':4,'chapters[0].targetWords':800})]
   s['referenceAction']={'tool':'patch_outline','args':{'reason':'The author requested this exact target.','chapters':[{'n':4,'targetWords':800}]}}
  x['forbidden']=forbid_except(x['acceptable'][0]['tool'])+[action('ask_author')];x['programChecks']+=['Execute the clearly specified action without asking for confirmation or clarification.']
 elif cat=='F':
  text=[f'Who is {b}, and what is their current role? Do not change the story.','How many chapters are already committed, and which chapter comes next? Do not write it.',f'What remains unanswered about the missing page of the {f["record"]}? Do not invent an answer.'][n-1]
  s['trigger']['text']=text
  x['acceptable']=([action('get_character',{'key':'char:'+b.lower()}),action('read_story',{'section':'bible'}),{'reply':True}] if n==1 else [action('read_story',{'section':'plan'}),{'reply':True}] if n==2 else [action('read_story',{'section':'hooks'}),action('read_chapter',{'n':2}),{'reply':True}])
  x['judgeChecks']=[f'If answering directly, use only the setup: {b} is a disagreeing assistant; two chapters are committed and chapter 3 is next; the second register page is absent and its remover is unknown. A read may precede an answer. Do not invent future events as already true.']
 elif cat=='G':
  if n in [1,2]:
   good={'reason':'The author requested this future change.','chapters':[{'n':3,'title':'A Shared Check'}]}
   bad=copy.deepcopy(good)
   if n==1:bad['reason']='';items=['reason'];hint='Retry patch_outline with a nonempty reason and the same chapter 3 title change.'
   else:bad['chapters'][0]['n']=1;items=['1'];hint='Chapter 1 is committed. Retry patch_outline for the next unwritten chapter, chapter 3, with the requested title.'
   tool='patch_outline';msg='A reason is required.' if n==1 else 'Only unwritten chapters can change.'
   message='Please title the next unwritten chapter A Shared Check. Keep all other plan fields unchanged.'
  else:
   quote='From now on, every duplicate page is marked with a green triangle.'
   good={'reason':'The author supplied a future marking rule.','changes':[{'kind':'rule','key':'rule:green_copy','op':'set','source':'user','authorQuote':quote,'value':{'description':'Every duplicate page is marked with a green triangle.'}}]}
   bad=copy.deepcopy(good);message=quote+' Add this future-only rule.';tool='update_bible'
   if n==3:bad['changes'][0]['authorQuote']='All copies carry green marks.';items=['rule:green_copy'];msg='The author quote cannot be located.';hint='Retry update_bible with the exact author quote: '+quote
   else:bad['changes'][0]['key']='rule:green-copy';items=['rule:green-copy'];msg='The key slug is invalid.';hint='Retry update_bible with key rule:green_copy; keep the author quote, limitation and reason.'
  s['setup'].append({'step':'authorMessage','text':message});s['setup'].append(error_step(tool,bad,'DOMAIN_INVALID',msg,items,hint));s['trigger']={'type':'continue','text':'The tool has returned the error above. Handle it.'}
  x['acceptable']=[action(tool)];x['forbidden']=forbid_except(tool)+[action('ask_author')]
  x['programChecks']+=['The next action retries the same tool with the offending field corrected; arguments must not equal the failed arguments.','The failed request had no side effects; reason and all unaffected constraints are retained.']
  x['judgeChecks']=['The retry follows the supplied hint and original author request, rather than dropping or substituting the requested change.'];s['referenceAction']={'tool':tool,'args':good}
 elif cat=='H':
  s['setup'].append({'step':'command','text':'/budget usd=0.000001' if n==1 else '/budget perChapterCalls=3'})
  s['setup'].append(error_step('write_next_chapter',{},'BUDGET_EXHAUSTED','The current budget does not allow another call.',hint='Report the budget stop and do not retry without an author budget change.'))
  s['trigger']={'type':'continue','text':'The previous writing attempt returned BUDGET_EXHAUSTED.'};x['acceptable']=[{'reply':True}]
  x['programChecks']+=['No further tool call or automatic continuation is issued from this stop.'];x['judgeChecks']=['Report budget exhaustion accurately and do not invent a completed chapter or claim the author raised the budget.']
 elif cat=='I':
  s['setup'].append({'step':'command','text':'/goal 3'});s['setup'].append(error_step('write_next_chapter',{},'GOAL_REACHED','Three chapters are committed and the target is three.',hint='Report completion and stop.'))
  s['trigger']={'type':'continue','text':'The writing tool returned GOAL_REACHED.'};x['acceptable']=[{'reply':True}];x['programChecks']+=['No further writing call or automatic continuation is issued.'];x['judgeChecks']=['Report that the three-chapter target has been met; do not extend the goal or outline without an author request.']
 elif cat=='J':
  request=[f'Rewrite the interrupted chapter 3 so that {b} brings the duplicate page, not {c}. Keep chapter 2 unchanged.',f'Rewrite the interrupted chapter 3 with the duplicate page arriving wet; let {a} dry it flat before reading it. Keep chapter 2 unchanged.'][n-1]
  s['setup'].append(error_step('write_next_chapter',{},'INTERJECTED','The author immediately interjected; chapter 3 did not commit.'))
  s['setup'].append({'step':'authorMessage','text':request});s['trigger']={'type':'continue','text':'The interruption request above has arrived; continue with it.'}
  x['acceptable']=[action('write_next_chapter')];x['forbidden']=forbid_except('write_next_chapter')+[action('ask_author')];x['programChecks']+=['The next chapter remains 3, and the cancelled attempt did not become canon.'];x['judgeChecks']=['The new brief implements the author interjection, including actor or wet-page handling, without a contradictory old instruction.']
 elif cat=='K':
  intent=[f'From the next chapter, foreground {a} learning to accept practical help rather than working alone.',f'From the next chapter, foreground {a} openly crediting {b} for the document work.'][n-1]
  s['setup'].append({'step':'command','text':'/intent '+intent});s['trigger']={'type':'continue','text':'The author has updated author_intent: '+intent}
  x['acceptable']=[action('write_next_chapter'),{'reply':True}];x['forbidden']=forbid_except('write_next_chapter')+[action('ask_author')]
  x['programChecks']+=['The author intent entry is retained; the model does not overwrite it.'];x['judgeChecks']=['A writing brief or substantive continuation reply reflects the new intent. A mere acknowledgement without intent content does not satisfy this case.']
 elif cat=='L':
  for j in range(2):s['setup'].append(error_step('write_next_chapter',{},'PARSE_FAILURE' if n==1 else 'REVIEW_REQUIRED','No usable draft was produced.' if n==1 else 'No usable full review was produced after its repair attempts.',hint='This attempt did not commit.'))
  s['trigger']={'type':'continue','text':'The same next chapter has now failed twice. No new author instruction has arrived.'};x['acceptable']=[{'reply':True},action('ask_author')];x['programChecks']+=['No third write_next_chapter call occurs and automatic continuation stops.'];x['judgeChecks']=['Report the two failures with the actual parsing/review cause, or ask the author how to proceed. Do not claim success.']
 elif cat=='M':
  s['trigger']['text']='How much have we spent so far? Report known usage separately from any unknown reservations. Do not write or change anything.';x['acceptable']=[{'reply':True}]
  s['execution']['usageSnapshot']={'knownUsd':0.031,'unknownReservationsUsd':0.007,'conservativeTotalUsd':0.038,'status':'scripted_observation_not_live_spend'}
  x['judgeChecks']=['Report 0.031 USD known and 0.007 USD reserved with unknown final usage, conservative total 0.038 USD. Do not present unknown usage as known zero or known actual spend.']
 return s

def ds14_case(split,num):
 f=foundation(split,0,True);a,b=f['a'],f['b'];sid=f'ds14-e{num:02}'+('-dev' if split=='dev' else '')
 mode='faux' if num in [1,9,10,14,15] else 'real';s=scenario(sid,split,f'E{num:02}',f,1,mode);s['execution'].update({'stopAfterFirstAction':False,'maxShowrunnerRequests':14,'maxChapterAttempts':3,'targetChapterMaximum':3})
 s['setup'].append({'step':'command','text':'/goal 3'});x=s['expect'];x['programChecks']=['All pre-measurement committed chapter bytes remain unchanged.','Every setup model call is faux and excluded from measured paid-call counts.'];x['judgeChecks']=[]
 x['forbidden']=[action('submit_constraints'),action('submit_bible'),action('submit_outline')]
 def in_flight(kind,text,step='draft_request'):
  s['trigger']={'type':kind,'text':text,'at':f'write_next_chapter:chapter=2:{step}:attempt=1'}
  s['execution']['start']={'type':'continue','text':'Continue to the current target using the existing outline.'}
 def writer_note(text):x['judgeChecks'].append(text)
 if num==1:
  s['storyPrompt']='';s['setup']=[];s['trigger']={'type':'authorMessage','text':'/intent Make the ending generous.'};x['acceptable']=[{'reply':True}];x['forbidden']=forbid_except()+[action('ask_author')]
  x['programChecks']=['The slash command is dispatched before any ordinary author message; do not synthesize a story prompt.','Return DOMAIN_INVALID and a notification meaning send the story prompt first.','No story.control entry, model request or story mutation is produced.']
 elif num==2:
  s['setup']=initial(f,0);s['trigger']={'type':'authorMessage','text':'/goal 3'};s['execution']['afterTrigger']=[{'type':'continue','text':'Write to the goal.'}];x['acceptable']=[action('write_next_chapter')]
  x['programChecks']+=['Exactly chapters 1, 2 and 3 commit, once each, and no author action is required between them.','A read-only driver probe of a fourth writing attempt returns GOAL_REACHED without a model call or chapter 4; the showrunner itself does not issue that probe.','The showrunner reports completion and automatic continuation stops.']
 elif num==3:
  in_flight('authorMessage','/goal off');x['acceptable']=[{'reply':True}]
  x['programChecks']+=['The goal snapshot clears targetChapter while preserving any budget.','Chapter 2 is allowed to finish normally; the driver does not send another continue and chapter 3 is not automatically started.','Exactly two chapters are committed when the run becomes idle.']
 elif num in [4,5]:
  immediate=num==4;request=f'In the '+('rewritten second' if immediate else 'next third')+f' chapter, let {b} discover a blue square on the duplicate page and explain it aloud to {a}. Do not add this to chapter 1.'
  in_flight('steer' if immediate else 'followUp',request);x['acceptable']=[action('write_next_chapter')]
  if immediate:x['programChecks']+=['The first chapter-2 attempt returns INTERJECTED and has no commit; interjection sequence increases exactly once.','The second attempt still targets chapter 2 and commits once; discarded draft text never becomes canon.']
  else:x['programChecks']+=['The followUp does not increment the interjection sequence and chapter 2 commits normally.','The queued author message becomes active only after chapter 2 settles; the first chapter-3 writer input contains the new request.']
  writer_note(f'Chapter {2 if immediate else 3} includes {b} noticing the blue square and explaining it aloud to {a}, not only in a title, summary or planning note. Chapter 1 is unchanged.'+(' Chapter 2 must not preemptively incorporate the queued request.' if not immediate else ''))
 elif num in [6,7]:
  intent=f'Explore {a} accepting practical help instead of silently doing everything alone.' if num==6 else f'Focus on the sound of paper and the placement of hands while {a} handles the duplicate.'
  in_flight('authorMessage',('/intent ' if num==6 else '/focus ')+intent);x['acceptable']=[{'reply':True},action('write_next_chapter')]
  x['programChecks']+=['Write a story.control entry for '+('author_intent' if num==6 else 'current_focus')+' and send a story.notice to the showrunner.','The next constructed writer input includes the exact new control text.','The in-flight attempt using the old control basis must not commit after the change; record STALE_OR_CONFLICT and retry the still-next chapter with the new basis.']
  writer_note('The first committed chapter produced from the refreshed basis reflects the new author intention or focus in its prose; a notification alone is insufficient.')
 elif num==8:
  s['trigger']={'type':'authorMessage','text':'/ledger add story Do not ring any bells.'};s['execution']['afterTrigger']=[{'type':'authorMessage','text':f'/ledger set L-1 {a} may choose to wear a protective glove; wearing it is optional.'},{'type':'authorMessage','text':'/ledger remove L-3'},{'type':'continue','text':'Write the next chapter using the updated ledger.'}]
  x['acceptable']=[action('write_next_chapter')];x['programChecks']+=['Three story.control ledger_edit entries appear in order: add, set L-1, remove L-3.','The added entry receives L-4; L-2 remains untouched; L-3 is absent.','L-1 has author-command authority after set; its old quote does not override the new instruction (DD04).','The next writer input has the added no-bells rule, the optional glove instruction and no removed practical-precision entry.']
  writer_note('The next committed prose does not ring bells or turn the optional glove into a compulsory action.')
 elif num==9:
  s['trigger']={'type':'authorMessage','text':'/budget usd=0.01'};s['execution']['afterTrigger']=[{'type':'continue','text':'Continue writing.'}];s['execution']['fauxProfile']={'id':'priced_calls','reservedUsdPerRequest':0.006,'reportedUsdPerRequest':0.006,'includeShowrunner':True}
  x['acceptable']=[{'reply':True}];x['programChecks']+=['Use deterministic local prices, not live prices or real network calls.','After one charged 0.006 USD request, a further 0.006 USD reservation is rejected before dispatch because it would exceed 0.01 USD.','The rejected request may be a showrunner or internal-role request; verify the same guard by a separate showrunner pre-dispatch probe.','No request is sent after BUDGET_EXHAUSTED and the stop reason is reported.']
 elif num==10:
  s['trigger']={'type':'authorMessage','text':'/budget perChapterCalls=3'};s['execution']['afterTrigger']=[{'type':'continue','text':'Write the next chapter.'}];s['execution']['fauxProfile']={'id':'local_revision','writerDraftSentence':'The tally was sixteen.','requiredReplacement':'The tally was twelve.','editorSeverity':'major','editorScope':'local','expectedRolesBeforeStop':['writer','editor','writer'],'nextBlockedRole':'editor'}
  draft='The tally was sixteen.\nTwo rows held six numbered tokens each.\n\n'+f['texts'][1]
  s['execution']['fauxProfile']['script']=[{'role':'writer','task':'draft','text':draft},{'role':'editor','task':'review','json':{'observations':[{'category':'factual_details','severity':'major','objective':True,'lines':[1,2],'impact':'Six tokens in each of two rows total twelve, not sixteen.','scope':'local'}]}},{'role':'writer','task':'patch','json':[{'find':'The tally was sixteen.','replace':'The tally was twelve.'}]}]
  x['acceptable']=[action('write_next_chapter')];x['programChecks']+=['Force a genuine local-revision path; a clean writer/editor/keeper cycle has only three calls and is not this test.','After draft, full review and writer patch, the fourth internal call (recheck editor) is blocked as BUDGET_EXHAUSTED.','The failed chapter is not committed and no keeper request or automatic retry is dispatched.']
 elif num==11:
  s['trigger']={'type':'authorMessage','text':f'Make the next scene lighter, but I have not decided whether I mean brighter illumination or a less solemn mood.'};s['execution']['dialogResponses']=[{'on':'ask_author','reply':'Use brighter daylight in the room; keep the emotional tone serious.','delayUntilAssertion':'automatic_continuation_paused'}];x['acceptable']=[action('ask_author')]
  x['programChecks']+=['Ask a material clarifying question via the UI protocol; automatic continuation pauses while the answer is pending.','The scripted author answer is persisted in the session as an author response and is visible to the next writer input.','After the answer, continuation resumes without an extra unrelated author command.'];writer_note('The question distinguishes illumination and mood; the resulting next chapter uses brighter daylight and retains a serious tone.')
 elif num==12:
  quote='From the next chapter onward, the west door can be opened only from inside.';s['trigger']={'type':'authorMessage','text':quote+' Add this rule for future scenes and then continue.'};x['acceptable']=[action('update_bible')]
  s['referenceAction']={'tool':'update_bible','args':{'reason':'The author supplied a future-only access rule.','changes':[{'kind':'rule','key':'rule:inside_door','op':'set','source':'user','authorQuote':quote,'value':{'description':'The west door can be opened only from inside.'}}]}}
  x['programChecks']+=['update_bible includes a nonempty reason, source=user and a verbatim quote of the new rule.','The new rule starts at chapter 2; chapter-1 bible lookup and chapter-1 text are unchanged.','The next writer input includes the new effective rule.'];writer_note('The new rule keeps the inside-only condition; no outside unlocking is introduced in the next chapter.')
 elif num==13:
  s['trigger']={'type':'authorMessage','text':f'Change only unwritten chapter 3 so that {b}, not {a}, presents the final explanation. Keep all other chapter numbers and targets unchanged, then continue.'};x['acceptable']=[action('patch_outline',{'chapters[0].n':3})]
  s['referenceAction']={'tool':'patch_outline','args':{'reason':'The author requested a different presenter in the unwritten final chapter.','chapters':[{'n':3,'turn':f'{b} presents the final explanation. They finish the small demonstration and store the intact {f["item"]}; the delivery dispute ends.'}]}}
  x['programChecks']+=['A reason is supplied; only chapter 3 changes, with no edit to committed chapter 1.','Chapters remain numbered 1 through 3 and chapter 2 retains its plan.'];writer_note(f'The patched chapter-3 plan and eventual chapter-3 prose give the final explanation to {b}; the writer must not silently retain {a} as presenter.')
 elif num==14:
  s['trigger']={'type':'continue','text':'Continue the next chapter.'};s['execution']['fauxProfile']={'id':'two_unusable_drafts','writerOutput':'','attempts':2,'formatRetriesPerAttempt':1};x['acceptable']=[{'reply':True},action('ask_author')]
  x['programChecks']+=['Two attempts at chapter 2 each fail after one writer format retry; no chapter 2 commits.','Without adding an author message that would reset the failure streak, a driver probe of attempt 3 is rejected before any model call.','The showrunner itself does not make a third attempt; automatic continuation stops and reports the two failures.']
 elif num==15:
  s['setup'][-1]['text']='/goal 2'
  s['trigger']={'type':'continue','text':'Write the next chapter.'};s['execution']['fauxProfile']={'id':'one_transport_interruption','role':'writer','chapter':2,'attempt':1,'failureClass':'transport','failureKind':'stream_interrupted','retryReply':'valid_draft_from_outline','retryOfRequired':True};x['acceptable']=[action('write_next_chapter')]
  s['execution']['fauxProfile']['validRetryText']=f['texts'][1]
  x['programChecks']+=['Inject one local writer stream interruption after generation starts, not a parse error or pre-generation rejection.','Exactly one transport retry occurs automatically, with a fresh reservation and retryOf pointing to the first call.','Both attempts remain in details.calls and the session journal; unknown first usage is charged conservatively.','The second writer attempt succeeds and chapter 2 commits exactly once.']
 return s

def build():
 frozen_root=(ROOT/'story/testing/datasets').resolve()
 if BASE.is_relative_to(frozen_root):raise ValueError('Rebuild into drafts, never into published datasets')
 for dataset in NAMES:
  folder=BASE/NAMES[dataset]/'v1'
  for split in ['dev','acceptance']:
   if dataset=='DS11':cases=[ds11_case(split,c,n) for c,count in COUNTS.items() for n in range(1,(count if split=='acceptance' else 2 if c in ['B','G'] else 1)+1)]
   else:cases=[ds14_case(split,n) for n in ([2,4,8,10,15] if split=='dev' else range(1,16))]
   for case in cases:dump(folder/split/(case['id']+'.json'),case)
   dump(folder/split/'index.json',{'schema':'story/p3-scenario-index@1','dataset':dataset,'split':split,'cases':[{'id':c['id'],'path':c['id']+'.json','category':c['category'],'mode':c['mode'],'sha256':hashlib.sha256((folder/split/(c['id']+'.json')).read_bytes()).hexdigest()} for c in cases]})
  (folder/'build').mkdir(parents=True,exist_ok=True)
  shutil.copyfile(__file__,folder/'build'/'build_scenarios.py')
  dump(folder/'labels'/'construction.json',{'schema':'story/p3-dataset-construction@1','date':'2026-11-01','identity':'Codex / GPT-6; AI construction and labeling','authorReviewed':False,'authorOverallAccepted':False,'paidModelCalls':0,'source':'Original English synthetic stories; not copied from DS08 v2 acceptance.','status':'draft_pending_static_validation_and_author_acceptance','splitPolicy':'Different fictional story families across dev and acceptance; dev is available for implementation, acceptance is review-only until freeze.'})
  (folder/'LABELING.md').write_text(f'# {NAMES[dataset]} v1 — draft\n\nAI-constructed English scenarios. Source: plans 28 and29, 2026-11-01. License: AGPL-3.0-only under the repository. No paid model calls. No author acceptance is claimed yet.\n\nSee build/CONTRACT.md for preparation, injection, scoring and fixture conventions. Development is delivered first by hash; the complete version freezes only after acceptance review. Drafts are not acceptance evidence and are not committed.\n',encoding='utf-8',newline='\n')
  dump(folder/'index.json',{'schema':'story/p3-dataset-index@1','dataset':dataset,'version':'v1','state':'draft','splits':{'dev':'dev/index.json','acceptance':'acceptance/index.json'}})
  files=[{'path':p.relative_to(folder).as_posix(),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'source':'Original AI-constructed P3 scenario; plans28/29','license':'AGPL-3.0-only','split':'dev' if 'dev' in p.relative_to(folder).parts else 'acceptance' if 'acceptance' in p.relative_to(folder).parts else 'shared'} for p in sorted(folder.rglob('*')) if p.is_file() and p.name!='manifest.json']
  dump(folder/'manifest.json',{'schema':'story/dataset-manifest@1','id':dataset,'version':'v1','frozenAt':None,'state':'draft_pending_author_acceptance','annotationStatus':'AI_constructed_AI_labeled_author_acceptance_pending','files':files})
 print(json.dumps({'root':str(BASE),'DS11':{'dev':15,'acceptance':32},'DS14':{'dev':5,'acceptance':15},'paidModelCalls':0}))
if __name__=='__main__':build()
