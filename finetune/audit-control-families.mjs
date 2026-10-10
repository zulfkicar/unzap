import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {importDefinitions} from '../src/migration.js';
const data='.data/finetune/dataset-7b-frozen-20261010/',run='.data/finetune/runs/qwen7b-20261010-v2/';
function controlFamily(source){
 const raw=importDefinitions(source)[0].steps,steps=[];
 const children=id=>raw.filter(s=>s.parent_id===id).sort((a,b)=>(a.params.mode==='fallback')-(b.params.mode==='fallback')||(a.params.order??0)-(b.params.order??0));
 const visit=s=>{steps.push(s);for(const child of children(s.id))visit(child);};
 visit(raw.find(s=>s.parent_id===null));
 const indices=new Map(steps.map((s,i)=>[s.id,i]));
 return createHash('sha256').update(JSON.stringify(steps.map(s=>{
  const groups=new Map(),p=s.params||{};
  for(const c of p.filter_criteria||[]){if(!groups.has(c.group))groups.set(c.group,[]);groups.get(c.group).push({match:c.match,action:c.action});}
  const predicates=[...groups.values()].map(g=>g.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const order=s.kind==='path'&&p.mode!=='fallback'?children(s.parent_id).filter(x=>x.params.mode!=='fallback').findIndex(x=>x.id===s.id):undefined;
  return {parent:s.parent_id==null?null:indices.get(s.parent_id),kind:s.kind,mode:p.mode,order,transform:p.transform,operation:p.operation,method:p.method,payload_type:p.payload_type,predicates};
 }))).digest('hex');
}
const report={classification:'Additional conservative control-pattern audit. Ignores field names, literal values and payload shapes and normalizes group identities. Familiar control patterns are not claimed as unseen composition.',test:{},counts:{}},train=new Set();
const progress=JSON.parse(readFileSync(run+'report.json')),excluded=new Set(progress.excluded_training);
for(const line of readFileSync(data+'train-upload.jsonl','utf8').trim().split('\n')){const t=JSON.parse(line);if(t.expected_action==='propose'&&!excluded.has(t.id))train.add(controlFamily(JSON.parse(t.messages[1].content).source));}
for(const line of readFileSync(data+'test-upload.jsonl','utf8').trim().split('\n')){
 const t=JSON.parse(line);if(t.expected_action!=='propose')continue;
 const fingerprint=controlFamily(JSON.parse(t.messages[1].content).source),familiar=train.has(fingerprint);
 report.test[t.id]={fingerprint,familiar_control_pattern:familiar};
 const k=(t.branches?'branch_':'linear_')+(familiar?'familiar':'unseen');report.counts[k]=(report.counts[k]||0)+1;
}
report.eligible_training_control_patterns=train.size;
writeFileSync(run+'control-family-audit.json',JSON.stringify(report,null,2));console.log(JSON.stringify({...report,test:undefined},null,2));
