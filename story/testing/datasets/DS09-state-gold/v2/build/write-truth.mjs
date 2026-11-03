import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { designs } from './design.mjs';
const directory=fileURLToPath(new URL('../truth/',import.meta.url));
mkdirSync(directory,{recursive:true});
for(const design of designs){const target=directory+design.id+'.json';assert(!existsSync(target),'Never overwrite an existing truth design; use an explicit pre-freeze revision record.');writeFileSync(target,JSON.stringify({schema:'story/state-truth-design@1',designedAt:new Date().toISOString(),designOrder:'truth_before_prose',split:'acceptance',...design},null,2)+'\n');}
console.log('Three new truth tables written before prose; no existing dataset was modified.');
