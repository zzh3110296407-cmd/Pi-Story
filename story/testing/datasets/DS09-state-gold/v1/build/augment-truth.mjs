// An explicit design revision, made before adding its corresponding prose.
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const designs={
 tide_register:[['Lena no longer trusted Tomas to interpret the archive without a witness.','guarded distrust','Tomas believed a public hearing would be safer than a private bargain.'],['Lena agreed to work with Tomas only while their notes remained open to the watch officer.','conditional cooperation','Lena believed the watch officer would attend the hearing.'],['Lena trusted Tomas to keep the archive open under the new public rules.','qualified trust','Tomas believed the published register would outlast their quarrel.']],
 borrowed_rain:[['Sera trusted Orin with the case but not with the choice of whose memory to spend.','limited trust','Sera believed Fenn would keep a receipt for every seed.'],['Sera and Orin agreed to share responsibility for every voluntary gift.','shared responsibility','Fenn believed the council would hear Sera before sunset.'],['Sera trusted Orin to teach the next apprentice without concealing the cost.','earned trust','Orin believed the new sapling would need ordinary care as well as rain.']],
 bakery_apartment:[['Naomi trusted Daniel to carry the shopping, but no longer trusted his account of the family papers.','guarded distrust','Ruth believed her children would stay for supper.'],['Naomi and Daniel agreed to check the lease together before either answered the landlord.','conditional cooperation','Naomi believed Mrs. Ames would attend the hall meeting.'],['Naomi trusted Daniel to share the accounts without making her ask twice.','earned trust','Daniel believed their mother would enjoy hearing the piano in the hall.']],
 quiet_europa:[['Nia trusted Anton with the wafer but required him to repeat every switch position aloud.','procedural trust','Mira believed the rescue window would remain open until the next orbit.'],['Nia no longer trusted Kes to choose which parts of the log she could read.','distrust of machine discretion','Nia believed Mira would preserve the independent recorder.'],['Nia accepted Kes as a witness whose decisions still required independent review.','accountable cooperation','Mira believed the relay crew would copy the audit before questioning them.']],
 last_impression:[['Elise trusted Jonas with the leaflet but not yet with the account of how it had arrived.','guarded trust','Miriam believed the county clerk would let them examine the register.'],['Elise and Jonas agreed to compare the original records without concealing another name.','conditional cooperation','Elise believed Miriam would return with a witness.'],['Elise trusted Jonas to keep the proofs without hiding inconvenient names.','earned trust','Jonas believed the apprentices would keep their own dated copies.']]
};
for(const [id,changes] of Object.entries(designs)){
 const file=path.join(root,'truth',id+'.json'),t=JSON.parse(readFileSync(file,'utf8'));
 if(t.revisionHistory?.some(x=>x.id==='explicit-relationships'))continue;
 t.revisionHistory=[{id:'explicit-relationships',at:new Date().toISOString(),note:'Designed explicit relationship and non-certain belief anchors before adding these sentences to prose; initial eight fact anchors and plot unchanged.'}];
 t.chapters.forEach((c,i)=>{const keys=Object.keys(t.cast);c.relationship={from:'char:'+keys[0],to:'char:'+(id==='quiet_europa'&&i>0?'kes':keys[1]),stance:changes[i][1],anchor:changes[i][0],key:true};c.believes=changes[i][2];if(i<2)c.memoryPredicate='location';});
 writeFileSync(file,JSON.stringify(t,null,2)+'\n');
}
console.log('Explicit relationship and belief design saved; prose additions follow.');
