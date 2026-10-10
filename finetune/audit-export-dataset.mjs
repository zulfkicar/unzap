import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {auditSanitized} from './sanitize.js';
const dir='.data/finetune/dataset-7b-frozen-20261010/';
const manifest=JSON.parse(readFileSync(dir+'manifest.json'));
const families={},report={passed:true,counts:{},family_overlap:[],source_audits:0};
for(const split of ['train','validation','test']){
 const rows=readFileSync(dir+split+'-upload.jsonl','utf8').trim().split('\n').map(JSON.parse);
 const audit=auditSanitized(rows.map(r=>JSON.parse(r.messages[1].content).source));
 if(!audit.passed)throw Error(split+' variant audit failed: '+JSON.stringify(audit));
 const sha=createHash('sha256').update(readFileSync(dir+split+'-upload.jsonl')).digest('hex');
 if(sha!==manifest.fingerprints[split])throw Error('Byte fingerprint mismatch');
 families[split]=new Set(rows.map(r=>r.family));report.counts[split]=rows.length;report.source_audits+=rows.length;
}
for(const [a,b] of [['train','validation'],['train','test'],['validation','test']]){
 const overlap=[...families[a]].filter(x=>families[b].has(x));if(overlap.length)throw Error('Graph-family split leakage');
}
writeFileSync(dir+'upload-audit.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
