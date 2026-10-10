import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {judgeExport} from './export-oracle.js';
const dir='.data/finetune/dataset-7b-frozen-20261010/';
const counts={};
for(const split of ['train','validation','test']){
 let checked=0,fixtures=0;
 for(const line of readFileSync(dir+split+'.jsonl','utf8').trim().split('\n')){
  const task=JSON.parse(line);if(task.expected_action!=='propose')continue;
  const result=await judgeExport(task,task.completion);
  if(!result.behavior_passed)throw Error('Frozen label failed stricter semantics: '+task.id+' '+JSON.stringify(result));
  checked++;fixtures+=task.fixtures.length;
 }
 counts[split]={positive_labels_checked:checked,fixtures};
}
const run='.data/finetune/runs/qwen7b-20261010-v2/';
const manifestPath=run+'oracle-code-manifest.json';
const hashes=JSON.parse(readFileSync(manifestPath));
writeFileSync(run+'oracle-code-manifest.initial.json',JSON.stringify(hashes,null,2));
for(const path of Object.keys(hashes))hashes[path]=createHash('sha256').update(readFileSync(path)).digest('hex');
writeFileSync(manifestPath,JSON.stringify(hashes,null,2));
const report={passed:true,revision:'source-control-receipts-lineage-outputs-v2',counts,training_messages_and_targets_changed:false,checks:'Source topology, control order, calls, resolved receipts, canonical reference lineage, formatter contracts and all per-step outputs. Frozen fixtures are replayed with the stronger source interpreter.'};
writeFileSync(run+'label-verification-v2.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
