import { readFileSync, writeFileSync } from 'node:fs';
import { testDraft } from '../src/agent.js';
import { expandedFixture } from './expanded-export-fixtures.mjs';
import { importDefinitions, validate } from '../src/migration.js';
const candidates=JSON.parse(readFileSync('.data/expanded-export-candidates.json','utf8'));
const seen=new Set(),cases=[];
for(const row of candidates) {
  if(seen.has(row.id)||row.definition.steps.length>3||row.definition.steps.some(s=>!['webhook','slack','sheets_append','sheets_update'].includes(s.kind)))continue;
  seen.add(row.id);
  try {
    const fixture=expandedFixture(row.source),d=importDefinitions(row.source)[0];
    d.steps.forEach(s=>s.review_required=false);
    const plan=validate(d);
    if(!plan.ready){cases.push({id:row.id,status:'blocked',passed:null,issues:plan.issues});continue;}
    const result=await testDraft(d,[fixture]);
    cases.push({id:row.id,status:'executed',source:row.source,definition:importDefinitions(row.source)[0],fixture,passed:result.passed,result});
  }catch(error){cases.push({id:row.id,passed:false,error:error.message});}
}
const report={classification:'Complete sanitized real-export chains, not extracted segments. Independently constructed source request fixtures. Shared scalar-reference codec. API responses are authored mocks, not original Zap run recordings. No model calls or SaaS writes.',cases,
 summary:{selected_complete_exports:cases.length,executed:cases.filter(c=>c.status==='executed').length,blocked:cases.filter(c=>c.status==='blocked').length,passed:cases.filter(c=>c.passed).length,sheets:cases.filter(c=>c.definition?.steps.some(s=>s.kind.startsWith('sheets_'))).length,slack_join:cases.filter(c=>c.definition?.steps.some(s=>s.params.join_channel)).length}};
writeFileSync('.data/expanded-export-replay.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,cases:cases.filter(c=>!c.passed).map(c=>({id:c.id,error:c.error,failures:c.result?.cases.filter(f=>!f.passed).map(f=>({error:f.error,actual_status:f.actual_status}))}))}));
if(cases.some(c=>c.passed===false))process.exitCode=1;
