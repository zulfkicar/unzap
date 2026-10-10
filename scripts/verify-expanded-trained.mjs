import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { modelConfiguration, migrateWithAgent } from '../src/agent.js';
const path='.data/expanded-trained-verification.json';
if(existsSync(path)&&!process.argv.includes('--resume'))throw Error('Preserve the existing verification. Resume only unfinished jobs.');
const report=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{classification:'Fresh trained 7B local inference on two complete sanitized exports using newly implemented contracts supplied in the prompt. These adapters were absent from the original fine-tune. Exact source contract plus independently authored request fixtures. Mock APIs. No deployment or provider writes.',cases:[],selected:[]};
const save=()=>writeFileSync(path,JSON.stringify(report,null,2));
if(!report.selected.length){
 const candidates=JSON.parse(readFileSync('.data/expanded-export-replay.json','utf8')).cases.filter(c=>c.passed).sort((a,b)=>JSON.stringify(a.source).length-JSON.stringify(b.source).length);
 for(const category of ['sheets','slack_join']){
  const c=candidates.find(c=>c.definition.steps.some(s=>category==='sheets'?s.kind.startsWith('sheets_'):s.params.join_channel));
  if(!c)throw Error('Missing actual expanded export candidate');
  report.selected.push({...c,category});
 }
 save();
}
for(const row of report.selected){
 if(report.cases.some(c=>c.id===row.id))continue;
 console.log(JSON.stringify({stage:'expanded-model',id:row.id,category:row.category}));
 const saved={id:row.id,category:row.category};
 try{
  const result=await migrateWithAgent({config:modelConfiguration({UNZAP_MODEL_PROVIDER:'llamacpp',UNZAP_MODEL_PROFILE:'trained-7b'}),definition:row.definition,fixtures:[row.fixture],maxTurns:3,
   onProgress:e=>{if(e.tool==='model'||e.status==='rejected')console.log(JSON.stringify({id:row.id,tool:e.tool,status:e.status,detail:e.detail}));}});
  saved.result=result;saved.passed=result.status==='draft_complete'&&result.tests?.passed===true;
 }catch(error){saved.error=error.message;saved.passed=false;}
 report.cases.push(saved);save();console.log(JSON.stringify({stage:'expanded-complete',id:row.id,category:row.category,passed:saved.passed,error:saved.error}));
}
report.summary={cases:report.cases.length,passed:report.cases.filter(c=>c.passed).length};save();console.log(JSON.stringify(report.summary));
if(report.cases.some(c=>!c.passed))process.exitCode=1;
