import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readZapArchive } from '../src/zip-import.js';
import { workflowsFrom } from '../src/importer.js';
import { importDefinitions, validate } from '../src/migration.js';
import { parseReference } from '../src/runtime.js';
import { sanitizeWorkflow, auditSanitized } from './sanitize.js';
import { sourceKind, controlFixtures, judgeExport } from './export-oracle.js';
import { taskMessages, wireDefinition } from './protocol.js';

const hash=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const inputPath=process.argv[2];if(!inputPath)throw Error('Supply a local private export ZIP. Only sanitized dataset files are written.');
const bytes=readFileSync(inputPath),raw=workflowsFrom(readZapArchive(bytes));
const sanitized=raw.map(sanitizeWorkflow),audit=auditSanitized(sanitized);
if(!audit.passed)throw Error('Sanitization allowlist failed: '+JSON.stringify(audit));
const out='.data/finetune/dataset-7b-frozen-20261010';mkdirSync(out,{recursive:true});
if(readFileExists(out+'/manifest.json'))throw Error('Preserve the existing v2 dataset before rebuilding.');
function readFileExists(p){try{readFileSync(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
const candidates=new Map(),rejections={},report={source_workflows:raw.length,sanitization:audit,full_conversions:0,supported_segments:0,refusal_templates:0,rejected_semantic_pairs:0,branch_templates:0,fixtures_checked:0};
const reject=k=>rejections[k]=(rejections[k]||0)+1;
function family(source){
 const nodes=Object.values(source.nodes),ids=new Map(nodes.map((n,i)=>[String(n.id),i]));
 return hash(nodes.map(n=>({parent:n.parent_id==null?null:ids.get(String(n.parent_id)),kind:sourceKind(n),action:n.action,
  transform:n.params?.transform,mode:n.params?.path_eval_stage===undefined?'rules':n.params?.isAlwaysRun?'always':'fallback',
  predicates:(n.params?.filter_criteria||[]).map(c=>({group:c.group,match:c.match,action:c.action})),
  shape:shape(n.params)})));
}
function shape(v){
 if(Array.isArray(v))return v.map(shape);
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[/^fields__/.test(k)?'fields__field':/^field_/.test(k)?'field':k,shape(x)]));
 if(typeof v==='string'&&v.includes('{{'))return 'reference';
 return typeof v;
}
function extract(workflow,start){
 const nodes=Object.values(workflow.nodes),ids=new Set([String(start.id)]);let changed=true;
 while(changed){changed=false;for(const n of nodes)if(ids.has(String(n.parent_id))&&!ids.has(String(n.id))){ids.add(String(n.id));changed=true;}}
 const selected=nodes.filter(n=>ids.has(String(n.id)));if(selected.length>15||selected.some(n=>sourceKind(n)==='unsupported'))return null;
 const boundary=new Map();
 const rewrite=v=>{
  if(Array.isArray(v))return v.map(rewrite);
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,rewrite(x)]));
  if(typeof v!=='string')return v;
  return v.replace(/\{\{([^}]+)\}\}/g,(whole,e)=>{const r=parseReference(e);if(!r||ids.has(r.step_id))return whole;
   const key=JSON.stringify(r);if(!boundary.has(key))boundary.set(key,'field_'+(5000+boundary.size));return '{{=gives["0"]["'+boundary.get(key)+'"]}}';});
 };
 const copy=Object.fromEntries(selected.map(n=>[String(n.id),{...n,parent_id:String(n.id)===String(start.id)?0:n.parent_id,params:rewrite(n.params)}]));
 copy['0']={id:0,parent_id:null,selected_api:'WebHookCLIAPI@1.0.0',action:'hook_v2',params:{}};
 return {title:'Sanitized workflow',nodes:copy};
}
function variant(source,index){
 const nodes=Object.values(source.nodes),ids=new Map(nodes.map((n,i)=>[String(n.id),String(1000+index*61+i)]));
 const key=s=>s.replace(/field_(\d+)/g,(_,n)=>'field_'+(Number(n)+index*101));
 const walk=v=>{
  if(Array.isArray(v))return v.map(walk);
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[key(k),walk(x)]));
  if(typeof v!=='string')return v;
  return v.replace(/\{\{([^}]+)\}\}/g,(whole,e)=>{const r=parseReference(e);return r?'{{=gives'+[ids.get(r.step_id)||r.step_id,...r.path.map(key)].map(k=>'['+JSON.stringify(k)+']').join('')+'}}':whole;}).replace(/value_(\d+)/g,(_,n)=>'value_'+(Number(n)+index*107)).replace(/endpoint_(\d+)/g,(_,n)=>'endpoint_'+(Number(n)+index*109));
 };
 return {title:'Sanitized workflow',nodes:Object.fromEntries(nodes.map(n=>[ids.get(String(n.id)),{...n,id:Number(ids.get(String(n.id))),parent_id:n.parent_id==null?null:Number(ids.get(String(n.parent_id))),params:walk(n.params)}]))};
}
async function consider(source,provenance){
 if(Object.keys(source.nodes).length>16){reject('too_many_nodes');return;}
 const sig=family(source);if(candidates.has(sig))return;
 const d=importDefinitions(source)[0];d.steps=d.steps.map(s=>({...s,review_required:false}));
 const plan=validate(d);
 if(!plan.ready){
  if(provenance!=='full_export'){reject('blocked_segment');return;}
  candidates.set(sig,{source,provenance,expected_action:'inspect',reason:'Source cannot be completely migrated: '+[...new Set(plan.issues.map(i=>i.code))].join(', '),branches:0});report.refusal_templates++;return;
 }
 const fixtures=controlFixtures(source);
 if(!fixtures.some(f=>f.expected.status==='succeeded')){reject('no_successful_fixture');return;}
 const task={source,expected_action:'propose',fixtures};
 const result=await judgeExport(task,{action:'propose',definition:wireDefinition(d)});
 report.fixtures_checked+=fixtures.length;
 if(!result.behavior_passed){report.rejected_semantic_pairs++;reject('source_native_disagreement');return;}
 const paths=d.steps.filter(s=>s.kind==='path');
 const uncovered=paths.filter(p=>p.params.mode==='rules'&&!fixtures.some(f=>f.expected.trace.some(t=>t.step_id===p.id&&t.decision===true)));
 if(uncovered.length){reject('unexercised_rule_branch');return;}
 const branches=d.steps.filter(s=>s.kind==='paths').length;
 candidates.set(sig,{source,provenance,expected_action:'propose',branches});
 report[provenance==='full_export'?'full_conversions':'supported_segments']++;if(branches)report.branch_templates++;
}
for(const workflow of sanitized){
 await consider(workflow,'full_export');
 for(const node of Object.values(workflow.nodes))if(node.parent_id!==null&&['paths','formatter','filter','http','slack','airtable','airtable_find','airtable_update'].includes(sourceKind(node))){const segment=extract(workflow,node);if(segment)await consider(segment,'supported_segment');}
}
const splits={train:[],validation:[],test:[]},splitFamilies={train:new Set(),validation:new Set(),test:new Set()};
const sorted=[...candidates].sort(([a],[b])=>a.localeCompare(b));
for(const [sig,candidate] of sorted){
 const slot=parseInt(sig.slice(0,8),16)%100;
 const split=candidate.branches>0?(slot<70?'train':slot<80?'validation':'test'):(slot<80?'train':slot<90?'validation':'test');
 const positive=candidate.expected_action==='propose';
 const repeats=split==='train'?(positive?8:4):(positive?3:1);
 if(!positive&&splits[split].filter(t=>t.expected_action==='inspect').length>=(split==='train'?500:50))continue;
 for(let i=0;i<repeats;i++){
  const source=variant(candidate.source,i+(split==='train'?0:split==='validation'?100:200));
  const id=split+'-'+sig.slice(0,12)+'-'+i;
  const task={id,family:sig,source,provenance:candidate.provenance,expected_action:candidate.expected_action,branches:candidate.branches,description:candidate.provenance==='supported_segment'?'Convert this supported segment from a real export. Its synthetic webhook supplies omitted ancestor outputs. Preserve all supplied IDs, links, branch modes, conditions and typed references.':'Convert this sanitized real export completely. Preserve every supplied ID and parent link. If any adapter or semantics are unsupported, inspect instead of silently dropping steps.'};
  if(positive){const d=importDefinitions(source)[0];d.name='workflow_'+id;d.steps=d.steps.map(s=>({...s,review_required:false}));task.completion={action:'propose',definition:wireDefinition(d)};task.fixtures=controlFixtures(source);
   const result=await judgeExport(task,task.completion);if(!result.behavior_passed)throw Error('Variant failed source-control oracle: '+id);
  }else{task.completion={action:'inspect',reason:candidate.reason};task.fixtures=[];}
  task.messages=[...taskMessages(task),{role:'assistant',content:JSON.stringify(task.completion)}];task.content_hash=hash(task);splits[split].push(task);splitFamilies[split].add(sig);
 }
}
for(const split of Object.keys(splits)){
 splits[split].sort((a,b)=>hash(a.id).localeCompare(hash(b.id)));
 writeFileSync(out+'/'+split+'.jsonl',splits[split].map(t=>JSON.stringify(t)).join('\n')+'\n');
 // Cloud gets only sanitized prompts/targets. Fixture and provenance evidence stay local.
 writeFileSync(out+'/'+split+'-upload.jsonl',splits[split].map(t=>JSON.stringify({id:t.id,family:t.family,expected_action:t.expected_action,branches:t.branches,messages:t.messages})).join('\n')+'\n');
}
const manifest={version:'unzap-sft-v2-real-exports',seed:20261010,source_sha256:hash(bytes),...report,rejections,counts:Object.fromEntries(Object.entries(splits).map(([k,v])=>[k,{examples:v.length,positive:v.filter(t=>t.expected_action==='propose').length,refusal:v.filter(t=>t.expected_action==='inspect').length,branch_examples:v.filter(t=>t.branches>0).length,families:splitFamilies[k].size}])),split_policy:'All variants of a normalized graph family stay together. Structural key includes node kinds, topology, predicate operators/groups, formatter transforms and parameter shapes. Test and validation families never enter training.',oracle:'Separate source-tree control interpreter versus native compiler. Exact execution order, calls, decisions and skipped/held statuses. Shared scalar reference and formatter codecs. Authored mocked integration responses, no original Zap run parity.',sanitization_policy:'Allowlisted protocol vocabulary only. All custom fields, free text, workflow names, IDs, endpoints and credentials replaced. Private code/unknown apps become opaque unsupported nodes.',fingerprints:Object.fromEntries(Object.keys(splits).map(k=>[k,hash(readFileSync(out+'/'+k+'-upload.jsonl'))])),promotion:'Training pairs are fixture-checked synthetic payload variants of sanitized export structures. Counts are not independent customer workflows or live provider validation.'};
writeFileSync(out+'/manifest.json',JSON.stringify(manifest,null,2));
console.log(JSON.stringify(manifest,null,2));
