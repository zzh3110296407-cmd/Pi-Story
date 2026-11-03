import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sharedAccounts } from './shared-accounts.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),sha=x=>createHash('sha256').update(x).digest('hex'),changes=[];
for(const name of readdirSync(root+'truth/')){const p=root+'truth/'+name,before=readFileSync(p),t=JSON.parse(before);let changed=false;
 for(const chapter of t.chapters)for(const f of chapter.facts){const mapping=sharedAccounts[f.subject];if(mapping){f.sharedResourceKey=f.subject;f.subject=mapping.subject;changed=true;}}
 for(const r of t.sharedResources??[]){const mapping=sharedAccounts[r.key];if(mapping){r.sharedResourceKey=r.key;r.key=mapping.subject;r.description=mapping.description;changed=true;}}
 if(changed){const after=JSON.stringify(t,null,2)+'\n';writeFileSync(p,after);changes.push({path:'truth/'+name,beforeSha256:sha(before),afterSha256:sha(after)});}
}
if(changes.length){const p=root+'labels/shared-account-namespace.json';if(existsSync(p))throw Error('Do not overwrite namespace audit');writeFileSync(p,JSON.stringify({date:'2026-10-30',cause:'P1 validateDelta rejects quantity predicates whose subject begins item:. It permits char: or org: only.',resolution:'Use org:expedition/org:relay_team/org:exhibition as shared-owner subjects, preserving the reviewed resource keys as sharedResourceKey metadata. No private-custodian proxy, arithmetic, prose or core change.',mappings:sharedAccounts,changes},null,2)+'\n');}
