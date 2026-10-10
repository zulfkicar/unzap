import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeWorkflow, auditSanitized } from '../finetune/sanitize.js';
import { controlFixtures, judgeExport } from '../finetune/export-oracle.js';
import { importDefinitions } from '../src/migration.js';
import { wireDefinition } from '../finetune/protocol.js';

test('training sanitizer removes credentials, PII, code and private keys',()=>{
 const raw={title:'PRIVATE_COMPANY_LABEL',nodes:{
  123456789:{id:123456789,parent_id:null,selected_api:'WebHookCLIAPI@1.0.29',action:'hook_v2',params:{key:''}},
  123456790:{id:123456790,parent_id:123456789,selected_api:'WebHookCLIAPI@1.0.29',action:'post',params:{url:'https://private-company.example/api/customer',headers:{Authorization:'Bearer TOP_SECRET_TOKEN'},data:{'PRIVATE_CUSTOMER_NAME':'John Sensitive','CNIC_NUMBER':'35202-9999999-1',email:'private@example.com',card:'4111111111111111',mapped:'{{123456789__PRIVATE_CUSTOMER_NAME}}'}}},
  123456791:{id:123456791,parent_id:123456790,selected_api:'PrivateBusinessAPI@99',action:'internalCode',params:{code:'PRIVATE_SOURCE_CODE',token:'PRIVATE_CREDENTIAL'}},
 }};
 const clean=sanitizeWorkflow(raw),serialized=JSON.stringify(clean);
 for(const secret of ['PRIVATE_COMPANY_LABEL','PRIVATE_CUSTOMER_NAME','John Sensitive','35202','private@example.com','4111111111111111','TOP_SECRET_TOKEN','private-company','PRIVATE_SOURCE_CODE','PrivateBusinessAPI','123456789'])assert.equal(serialized.includes(secret),false,secret);
 assert.equal(auditSanitized([clean]).passed,true);
 assert.equal(clean.nodes['3'].selected_api,'UnsupportedAPI');
});

test('ambiguous copied-step aliases remain unresolved after sanitization',()=>{
 const clean=sanitizeWorkflow({nodes:{
  1:{id:1,parent_id:null,selected_api:'WebHookCLIAPI@1',action:'hook_v2',params:{}},
  2:{id:2,parent_id:1,selected_api:'ZapierFormatterCLIAPI@1',action:'text_line_item',triple_stores:{copied_from:444444444},params:{transform:'string.lower_case',inputs:'{{1__name}}'}},
  3:{id:3,parent_id:2,selected_api:'ZapierFormatterCLIAPI@1',action:'text_line_item',triple_stores:{copied_from:444444444},params:{transform:'string.lower_case',inputs:'{{444444444__output}}'}},
 }});
 assert.match(clean.nodes['3'].params.inputs,/gives\["9000"\]/);
});

test('sanitization renames group identities without collapsing AND/OR partitions',()=>{
 const clean=sanitizeWorkflow({nodes:{1:{id:1,parent_id:null,selected_api:'WebHookCLIAPI@1',action:'hook_v2',params:{}},2:{id:2,parent_id:1,selected_api:'FilterAPI',action:'filter',params:{filter_criteria:[
  {group:'PRIVATE_GROUP_A_123456789',key:'{{1__first}}',match:'iexact',value:'yes',action:'continue'},
  {group:'PRIVATE_GROUP_B_987654321',key:'{{1__second}}',match:'iexact',value:'yes',action:'continue'},
  {group:'PRIVATE_GROUP_A_123456789',key:'{{1__third}}',match:'iexact',value:'yes',action:'continue'},
 ]}}}});
 assert.deepEqual(clean.nodes['2'].params.filter_criteria.map(c=>c.group),[0,1,0]);
 assert.equal(JSON.stringify(clean).includes('PRIVATE_GROUP'),false);
});

const node=(id,parent,app,action,params={})=>({id,parent_id:parent,selected_api:app,action,params});
const condition=(key,match,value,group=0)=>({group,key:'{{1__'+key+'}}',match,value,action:'continue'});
const source={nodes:{
  1:node(1,null,'WebHookCLIAPI@1','hook_v2'),
  2:node(2,1,'BranchingAPI','branch'),
  3:node(3,2,'BranchingAPI','filter',{path_eval_index:0,filter_criteria:[condition('units','igreater','10')]}),
  4:node(4,3,'FilterAPI','filter',{filter_criteria:[condition('allowed','boolean','true')]}),
  5:node(5,4,'WebHookCLIAPI@1','post',{url:'https://example.test/first',payload_type:'json',data:{units:'{{1__units}}'}}),
  6:node(6,2,'BranchingAPI','filter',{path_eval_index:1,filter_criteria:[condition('units','igreater','5')]}),
  7:node(7,6,'WebHookCLIAPI@1','post',{url:'https://example.test/second',payload_type:'json',data:{units:'{{1__units}}'}}),
  8:node(8,2,'BranchingAPI','filter',{path_eval_index:2,path_eval_stage:9}),
  9:node(9,8,'WebHookCLIAPI@1','post',{url:'https://example.test/fallback',payload_type:'json',data:{units:'{{1__units}}'}}),
}};
const definition=()=>{const d=importDefinitions(source)[0];d.steps=d.steps.map(s=>({...s,review_required:false}));return d;};
const task=()=>({expected_action:'propose',source,fixtures:controlFixtures(source)});
const proposal=d=>({action:'propose',definition:wireDefinition(d)});

test('source oracle verifies all matching paths, fallback and branch-local stops',async()=>{
 const t=task(),result=await judgeExport(t,proposal(definition()));
 assert.equal(result.behavior_passed,true,JSON.stringify(result));
 assert(t.fixtures.some(f=>f.expected.calls.includes('5')&&f.expected.calls.includes('7')));
 assert(t.fixtures.some(f=>f.expected.calls.includes('7')&&!f.expected.calls.includes('5')));
 assert(t.fixtures.some(f=>f.expected.calls.includes('9')));
});

test('source oracle rejects compiler-valid branch, order and request mutations',async()=>{
 for(const mutation of [
  d=>{d.steps.find(s=>s.id==='6').params.filter_criteria[0].match='iless';},
  d=>{d.steps.find(s=>s.id==='3').params.order=3;},
  d=>{d.steps.find(s=>s.id==='5').params.data.units='0';},
  d=>{d.steps.find(s=>s.id==='7').params.url='https://example.test/wrong';},
 ]){
  const d=definition();mutation(d);const result=await judgeExport(task(),proposal(d));
  assert.equal(result.compiler_valid,true);assert.equal(result.behavior_passed,false);
 }
});

test('nested source paths preserve grouped AND/OR and inner fallback decisions',async()=>{
 const nested=structuredClone(source);
 nested.nodes[3].params.filter_criteria=[condition('units','igreater','10',0),condition('allowed','boolean','true',0),condition('label','iexact','priority',1)];
 nested.nodes[4]=node(4,3,'BranchingAPI','branch');
 nested.nodes[5]=node(5,4,'BranchingAPI','filter',{path_eval_index:0,filter_criteria:[condition('expedited','boolean','true')]});
 nested.nodes[10]=node(10,5,'WebHookCLIAPI@1','post',{url:'https://example.test/nested-fast',data:{units:'{{1__units}}'}});
 nested.nodes[11]=node(11,4,'BranchingAPI','filter',{path_eval_index:1,path_eval_stage:9});
 nested.nodes[12]=node(12,11,'WebHookCLIAPI@1','post',{url:'https://example.test/nested-normal',data:{units:'{{1__units}}'}});
 const d=importDefinitions(nested)[0];d.steps=d.steps.map(s=>({...s,review_required:false}));
 const fixtures=controlFixtures(nested);
 assert(fixtures.some(f=>f.expected.calls.includes('10')));
 assert(fixtures.some(f=>f.expected.calls.includes('12')));
 assert.equal((await judgeExport({expected_action:'propose',source:nested,fixtures},proposal(d))).behavior_passed,true);
});

test('always paths run alongside matching rules without suppressing siblings',async()=>{
 const always=structuredClone(source);delete always.nodes[8];delete always.nodes[9];
 always.nodes[6].params={path_eval_index:1,path_eval_stage:9,isAlwaysRun:true};
 const d=importDefinitions(always)[0];d.steps=d.steps.map(s=>({...s,review_required:false}));
 const fixtures=controlFixtures(always);
 assert(fixtures.filter(f=>f.expected.status!=='held').every(f=>f.expected.calls.includes('7')));
 assert.equal((await judgeExport({expected_action:'propose',source:always,fixtures},proposal(d))).behavior_passed,true);
});

test('reference-lineage gate rejects swapped mappings even with identical sample values',async()=>{
 const s={nodes:{1:node(1,null,'WebHookCLIAPI@1','hook_v2'),2:node(2,1,'WebHookCLIAPI@1','post',{url:'https://example.test/lineage',data:{first:'{{1__a}}',second:'{{1__b}}'}})}};
 const d=importDefinitions(s)[0],fixtures=controlFixtures(s);
 [d.steps[1].params.data.first,d.steps[1].params.data.second]=[d.steps[1].params.data.second,d.steps[1].params.data.first];
 const result=await judgeExport({source:s,expected_action:'propose',fixtures},proposal(d));
 assert.equal(result.compiler_valid,true);assert.equal(result.behavior_passed,false);assert.match(result.error,/lineage/);
});

test('isolated formatter leaves must retain their operation and mapped input',async()=>{
 const s={nodes:{1:node(1,null,'WebHookCLIAPI@1','hook_v2'),2:node(2,1,'ZapierFormatterCLIAPI@1','text_line_item',{transform:'string.lower_case',inputs:'{{1__label}}'})}};
 const d=importDefinitions(s)[0];d.steps[1].params.transform='string.upper_case';
 const result=await judgeExport({source:s,expected_action:'propose',fixtures:controlFixtures(s)},proposal(d));
 assert.equal(result.compiler_valid,true);assert.equal(result.behavior_passed,false);
});
