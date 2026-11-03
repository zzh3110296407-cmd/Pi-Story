import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const sha=x=>createHash('sha256').update(x).digest('hex');
const changes=[];
for(const name of readdirSync(root+'truth/')){
 const file=root+'truth/'+name,before=readFileSync(file),truth=JSON.parse(before);
 for(const chapter of truth.chapters)for(const hook of chapter.hooks)if(hook[1]==='payoff')hook[1]='resolve';
 const after=JSON.stringify(truth,null,2)+'\n';
 if(sha(before)!==sha(after)){if(existsSync(root+'acceptance/chapters/'+truth.id+'-c1.md'))throw Error('Design normalization must precede prose');writeFileSync(file,after);changes.push({path:'truth/'+name,beforeSha256:sha(before),afterSha256:sha(after)});}
}
if(changes.length)writeFileSync(root+'build/design-normalization.json',JSON.stringify({date:new Date().toISOString(),phase:'before_prose',reason:'Map the design term payoff to the frozen P1 hook operation resolve; no narrative or gold verdict changes.',changes},null,2)+'\n');
