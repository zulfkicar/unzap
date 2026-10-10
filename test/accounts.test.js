import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { importDefinitions } from '../src/migration.js';
import { assignAccount, providers } from '../src/accounts.js';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { bindingsFor, bundle } from '../src/bundle.js';
import { verifySourceProposal } from '../src/trained-contract.js';
import { accountSelector, connectionForm, connectionsPage } from '../public/connections-view.js';
import { gunzipSync } from 'node:zlib';
const source={title:'Accounts fixture',nodes:{
  1:{id:1,parent_id:null,selected_api:'WebHookAPI',action:'hook_v2',params:{}},
  2:{id:2,parent_id:1,selected_api:'AirtableCLIAPI@3.0',action:'createRecord',authentication_id:'source-account-one',params:{applicationId:'app_demo',tableName:'Records',fields__Name:'{{1__name}}'}},
  3:{id:3,parent_id:2,selected_api:'AirtableCLIAPI@3.0',action:'updateRecord',authentication_id:'source-account-one',params:{applicationId:'app_demo',tableName:'Records',rowId:'{{2__id}}',fields__Name:'{{1__name}}'}},
  4:{id:4,parent_id:3,selected_api:'AirtableCLIAPI@3.0',action:'createRecord',authentication_id:'source-account-two',params:{applicationId:'app_other',tableName:'Records',fields__Name:'{{1__name}}'}},
}};
test('imports share known source accounts across steps/workflows while distinct and unknown accounts stay separate',()=>{
 const d=importDefinitions(source)[0];
 assert.equal(d.steps[1].params.connection,d.steps[2].params.connection);
 assert.notEqual(d.steps[1].params.connection,d.steps[3].params.connection);
 assert.equal(JSON.stringify(d).includes('source-account-one'),false);
 const other=structuredClone(source);other.nodes[2].id=12;other.nodes[3].id=13;other.nodes[3].parent_id=12;other.nodes[4].id=14;other.nodes[4].parent_id=13;
 assert.equal(importDefinitions(other)[0].steps[1].params.connection,d.steps[1].params.connection);
 const unknown=structuredClone(source);delete unknown.nodes[2].authentication_id;delete unknown.nodes[3].authentication_id;
 assert.notEqual(importDefinitions(unknown)[0].steps[1].params.connection,importDefinitions(unknown)[0].steps[2].params.connection);
});
test('one encrypted account serves several actions, keeps source contracts and exports one binding',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'unzap-accounts-')),store=new Store(dir);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const original=importDefinitions(source)[0],account={provider:'airtable',binding:'AIRTABLE_OPERATIONS'};
 const d=assignAccount(original,['2','3','4'],account);d.steps.forEach(s=>s.review_required=false);
 store.connect(account.binding,'Operations','synthetic-account-secret','airtable');
 assert.equal(store.connections().length,1);
 assert.equal(JSON.stringify(store.connections()).includes('synthetic-account-secret'),false);
 assert.deepEqual(bindingsFor(d),[account.binding]);
 assert.equal(gunzipSync(await bundle(d)).includes(Buffer.from('src/accounts.js')),true);
 const restored=structuredClone(d);verifySourceProposal(restored,d);assert.equal(restored.steps[1].params.connection,account.binding);
 const id=store.add(d),calls=[];
 const runner=new Runner(store,{transport:async(r,s)=>{calls.push(r);return s.kind==='airtable_update'?{id:'rec_demo',fields:{Name:'Ada'}}:{records:[{id:'rec_demo',fields:{Name:'Ada'}}]};}});
 assert.equal((await runner.start(id,{name:'Ada'},{mode:'live'})).status,'succeeded');
 assert.equal(calls.length,3);assert.ok(calls.every(r=>r.headers.Authorization==='Bearer synthetic-account-secret'));
  store.db.prepare('UPDATE workflows SET active_version=1 WHERE id=?').run(id);
  store.connect('AIRTABLE_ARCHIVE','Archive','synthetic-other-account','airtable');
  store.save(id,assignAccount(d,['2'],{provider:'airtable',binding:'AIRTABLE_ARCHIVE'}),1);
  assert.equal(store.get(id).active_version,1);
  assert.equal(store.get(id).definition.steps[1].params.connection,'AIRTABLE_ARCHIVE');
  assert.equal(store.get(id,1).definition.steps[1].params.connection,'AIRTABLE_OPERATIONS');
 assert.throws(()=>assignAccount(d,['2'],{provider:'slack',binding:'SLACK_TEAM'}),/different app/);
 assert.throws(()=>assignAccount(d,['1'],account),/account-based/);
 assert.throws(()=>assignAccount(d,['2','2'],account),/distinct/);
});
test('named account API supports reuse, multiple identities, metadata-only edits and optimistic draft assignment',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'unzap-account-api-')),token='synthetic-control-account-tests';
 const child=spawn(process.execPath,['src/server.js'],{cwd:process.cwd(),env:{...process.env,DATA_DIR:dir,CONTROL_TOKEN:token,HOST:'127.0.0.1',PORT:'0'},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}rmSync(dir,{recursive:true,force:true});});
 const ready=await once(child.stdout,'data'),origin='http://127.0.0.1:'+JSON.parse(String(ready[0])).port;
 const asset=await fetch(origin+'/connections-view.js');
 assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/javascript/);assert.match(await asset.text(),/export function connectionsPage/);
 const api=async(path,body)=>{const r=await fetch(origin+'/api'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,Origin:origin,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,data:await r.json()};};
 const a=await api('/connections',{operation:'create',provider:'airtable',label:'Operations',secret:'synthetic-pat-one'});
 const b=await api('/connections',{operation:'create',provider:'airtable',label:'Archive',secret:'synthetic-pat-two'});
 assert.equal(a.status,201);assert.notEqual(a.data.binding,b.data.binding);assert.equal(a.data.connections[0].provider,'airtable');
 assert.equal(JSON.stringify(a.data).includes('synthetic-pat-one'),false);
 assert.equal((await api('/connections',{operation:'create',binding:a.data.binding,provider:'airtable',label:'Collision',secret:'replacement'})).status,400);
 assert.equal((await api('/connections',{operation:'edit',binding:a.data.binding,provider:'slack',label:'Wrong app',secret:'replacement'})).status,400);
 assert.equal((await api('/connections',{operation:'edit',binding:a.data.binding,provider:'airtable',label:'Renamed operations',secret:''})).status,201);
 const imported=await api('/import',source),id=imported.data.ids[0];
 const assigned=await api('/workflows/'+id+'/connections',{version:1,binding:a.data.binding,step_ids:['2','3']});
 assert.equal(assigned.status,200);assert.equal(assigned.data.version,2);assert.equal(assigned.data.active_version,null);
 assert.equal(assigned.data.definition.steps[1].params.connection,a.data.binding);assert.equal(assigned.data.definition.steps[2].review_required,true);
 assert.equal((await api('/workflows/'+id+'/connections',{version:1,binding:b.data.binding,step_ids:['2']})).status,409);
 const state=(await api('/state')).data;assert.equal(state.connections.length,2);assert.equal(JSON.stringify(state).includes('synthetic-pat'),false);
 // A metadata edit with a blank credential must keep the encrypted value.
 const db=new Store(dir);assert.equal(db.secrets()[a.data.binding],'synthetic-pat-one');db.close();
});
test('account screens expose setup instructions, saved account names and safe credential replacement',()=>{
 const state={providers,connections:[{binding:'AIRTABLE_OPERATIONS',label:'Operations <img>',provider:'airtable',created_at:'2026-10-10'}]};
 const page=connectionsPage(state,()=> 'Oct 10');
 assert.match(page,/Connect once/);assert.match(page,/Operations &lt;img&gt;/);
 const picker=accountSelector('airtable_find',{connection:'AIRTABLE_OPERATIONS'},state,'3');
 assert.match(picker,/Operations &lt;img&gt;/);assert.doesNotMatch(picker,/SLACK/);
 const form=connectionForm(state,{provider:'airtable'});
 assert.match(form,/data.records:read/);assert.match(form,/data.records:write/);assert.match(form,/Generated automatically/);
 const edit=connectionForm(state,{existing:state.connections[0]});assert.match(edit,/leave blank to keep current/);
 assert.match(connectionForm(state,{provider:'google_sheets'}),/Use Google sign-in for automatic token renewal/);
});
