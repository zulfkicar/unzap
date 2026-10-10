import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {judgeExport} from './export-oracle.js';
const run='.data/finetune/runs/qwen7b-20261010-v2/',data='.data/finetune/dataset-7b-frozen-20261010/';
const codeHashes=JSON.parse(readFileSync(run+'oracle-code-manifest.json'));
for(const [path,expected] of Object.entries(codeHashes))if(createHash('sha256').update(readFileSync(path)).digest('hex')!==expected)throw Error('Oracle/runtime changed during the experiment: '+path);
const generations=JSON.parse(readFileSync(run+'generations.json'));
const tasks=new Map(readFileSync(data+'test.jsonl','utf8').trim().split('\n').map(line=>{const task=JSON.parse(line);return [task.id,task];}));
const controlAudit=JSON.parse(readFileSync(run+'control-family-audit.json'));
const rows=[];
for(const row of generations.records){
 const task=tasks.get(row.id);if(!task)throw Error('Unknown held-out case');
 const result={id:row.id,family:row.family,branches:row.branches,expected_action:row.expected_action,control_pattern:controlAudit.test[row.id]||null,models:{}};
 for(const [model,output] of Object.entries(row.outputs)){
  let parsed=false,score;
  try{const command=JSON.parse(output.text);parsed=true;score=await judgeExport(task,command);}
  catch(error){score={parsed,compiler_valid:false,behavior_passed:false,error:error.message};}
  result.models[model]={...score,tokens:output.tokens,seconds:output.seconds,token_limit_reached:output.token_limit_reached,deadline_interrupted:output.deadline_interrupted};
  const fence=output.text.match(/^\s*```(?:json)?\s*\n([\s\S]*)\n```\s*$/i);
  let diagnostic=score;
  if(fence){let valid=false;try{const command=JSON.parse(fence[1]);valid=true;diagnostic=await judgeExport(task,command);}catch(error){diagnostic={parsed:valid,compiler_valid:false,behavior_passed:false,error:error.message};}}
  result.models[model].fence_only={...diagnostic,wrapper_removed:Boolean(fence)};
 }
 rows.push(result);
}
const paired=rows.filter(r=>r.models.base&&r.models.adapter&&!r.models.base.deadline_interrupted&&!r.models.adapter.deadline_interrupted);
function rates(subset,model,diagnostic=false){
 const value=r=>diagnostic?r.models[model].fence_only:r.models[model];
 const proposals=subset.filter(r=>r.expected_action==='propose'),refusals=subset.filter(r=>r.expected_action==='inspect');
 return {tasks:subset.length,json_valid:subset.filter(r=>value(r).parsed).length,proposals:proposals.length,compiler_valid:proposals.filter(r=>value(r).compiler_valid).length,behavior_passed:proposals.filter(r=>value(r).behavior_passed).length,refusals:refusals.length,refusal_passed:refusals.filter(r=>value(r).refusal_passed).length,overall_passed:subset.filter(r=>value(r).behavior_passed).length,fixtures:proposals.reduce((s,r)=>s+tasks.get(r.id).fixtures.length,0),fixture_passed:proposals.reduce((s,r)=>s+(value(r).cases||[]).filter(c=>c.passed).length,0)};
}
const available={base:rates(rows.filter(r=>r.models.base&&!r.models.base.deadline_interrupted),'base'),adapter:rates(rows.filter(r=>r.models.adapter&&!r.models.adapter.deadline_interrupted),'adapter')};
const fenceOnly={classification:'Post-hoc diagnostic, applied identically to both models. Removes only a single enclosing Markdown JSON fence. No field, syntax, topology or workflow repair.',base:rates(paired,'base',true),adapter:rates(paired,'adapter',true),branches:{base:rates(paired.filter(r=>r.branches>0),'base',true),adapter:rates(paired.filter(r=>r.branches>0),'adapter',true)},available_base:rates(rows.filter(r=>r.models.base&&!r.models.base.deadline_interrupted),'base',true)};
const summary={status:generations.status,paired_cases:paired.length,available_unpaired:available,base:rates(paired,'base'),adapter:rates(paired,'adapter'),branches:{base:rates(paired.filter(r=>r.branches>0),'base'),adapter:rates(paired.filter(r=>r.branches>0),'adapter')},nonbranches:{base:rates(paired.filter(r=>!r.branches),'base'),adapter:rates(paired.filter(r=>!r.branches),'adapter')},wins:paired.filter(r=>!r.models.base.behavior_passed&&r.models.adapter.behavior_passed).length,regressions:paired.filter(r=>r.models.base.behavior_passed&&!r.models.adapter.behavior_passed).length,classification:'Sanitized real-export structures and explicitly marked supported segments, synthetic payload variants and authored integration responses. Held-out graph families. Exact source-control, action parameters and topology tests. Shared reference/formatter codecs. No live API or original Zap run equivalence claim.',rows};
summary.fence_only_diagnostic=fenceOnly;
summary.control_patterns={classification:controlAudit.classification,unseen_branches:{base:rates(paired.filter(r=>r.branches>0&&r.control_pattern?.familiar_control_pattern===false),'base'),adapter:rates(paired.filter(r=>r.branches>0&&r.control_pattern?.familiar_control_pattern===false),'adapter'),fence_only_base:rates(paired.filter(r=>r.branches>0&&r.control_pattern?.familiar_control_pattern===false),'base',true),fence_only_adapter:rates(paired.filter(r=>r.branches>0&&r.control_pattern?.familiar_control_pattern===false),'adapter',true)},familiar_branches:{base:rates(paired.filter(r=>r.branches>0&&r.control_pattern?.familiar_control_pattern===true),'base'),adapter:rates(paired.filter(r=>r.branches>0&&r.control_pattern?.familiar_control_pattern===true),'adapter')}};
writeFileSync(run+'evaluation-report.json',JSON.stringify(summary,null,2));
console.log(JSON.stringify({...summary,rows:undefined},null,2));
