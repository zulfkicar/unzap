import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importDefinitions, validate, compile } from '../src/migration.js';
import { requestFor, normalizeOutput } from '../src/connectors.js';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { webhookInput } from '../src/runtime.js';
import { verifySourceProposal } from '../src/trained-contract.js';
import { bundle } from '../src/bundle.js';
import { gunzipSync } from 'node:zlib';

const source = (app, action, params, rootParams = {}) => ({ title: 'Integration fixture', nodes: {
  1: { id: 1, parent_id: null, selected_api: 'WebHookCLIAPI@1.0.0', action: 'hook_v2', params: rootParams },
  2: { id: 2, parent_id: 1, selected_api: app, action, params },
} });
function reviewed(raw) {
  const d = importDefinitions(raw)[0];
  d.steps.forEach(s => s.review_required = false);
  return d;
}
function setup(t, d, transport) {
  const dir = mkdtempSync(join(tmpdir(), 'unzap-expanded-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const id = store.add(d);
  for (const s of d.steps) if (s.params.connection) store.connect(s.params.connection, 'Synthetic', 'synthetic-test-token');
  return { store, id, runner: new Runner(store, { transport }) };
}
const slackSource = () => source('SlackCLIAPI@1.39.3', 'channel_message', { channel: 'C123456', text: '{{1__message}}', as_bot: true, add_app_to_channel: true, add_edit_link: false });
test('Slack auto-join preserves source intent, journals membership separately, and reuses it on safe resume', async t => {
  const original = importDefinitions(slackSource())[0], d = reviewed(slackSource());
  assert.equal(original.steps[1].kind, 'slack');
  assert.equal(d.steps[1].params.join_channel, true);
  assert.equal(validate(d).ready, true);
  const calls = []; let deny = true;
  const { store, id, runner } = setup(t,d,async request => {
    calls.push(request);
    if (request.url.endsWith('conversations.join')) return { ok: true, channel: { id: 'C123456', is_member: true }, warning: 'already_in_channel' };
    return deny ? { ok: false, error: 'missing_scope' } : { ok: true, channel: 'C123456', ts: '1700000000.000001' };
  });
  const held = await runner.start(id,{ message: 'Test message' },{ key: 'k', mode: 'live' });
  assert.equal(held.status,'held');
  store.db.prepare('UPDATE steps SET started_at=? WHERE run_id=?').run('2026-10-10T00:00:00.000Z',held.id);
  assert.deepEqual(store.run(held.id).steps.map(s=>s.step_id),['1','2__join','2']);
  assert.deepEqual(held.steps.map(s => [s.step_id,s.status]), [['1','succeeded'],['2__join','succeeded'],['2','held']]);
  assert.equal(calls.length,2);
  assert.deepEqual(JSON.parse(calls[0].body),{ channel: 'C123456' });
  assert.deepEqual(JSON.parse(calls[1].body),{ channel: 'C123456', text: 'Test message' });
  deny = false;
  const done = await runner.start(id,{ message: 'Test message' },{ mode:'live', resumeId:held.id });
  assert.equal(done.status,'succeeded');
  assert.equal(calls.filter(r => r.url.endsWith('conversations.join')).length,1);
  assert.equal(JSON.stringify(store.run(done.id).steps).includes('synthetic-test-token'),false);
  assert.throws(() => verifySourceProposal({ ...d, steps: d.steps.map(s => s.kind === 'slack' ? { ...s,params:{...s.params,join_channel:false} } : s) },original),/Source contract changed/);
});
test('unconfirmed Slack membership stops delivery and uncertain join writes cannot automatically resume', async t => {
  const d=reviewed(slackSource()),calls=[];
  const { id, runner }=setup(t,d,async r => { calls.push(r);return {ok:true,channel:{id:'COTHER',is_member:true}}; });
  const run=await runner.start(id,{message:'Hello'},{mode:'live'});
  assert.equal(run.status,'held');assert.equal(calls.length,1);
  assert.equal(run.steps.find(s=>s.step_id==='2__join').status,'uncertain');
  await assert.rejects(()=>runner.start(id,{message:'Hello'},{mode:'live',resumeId:run.id}),/Reconcile/);
  for(const params of [{add_edit_link:true},{as_bot:false},{file:'file.pdf'},{post_at:'1800000000'}])
    assert.equal(importDefinitions(source('SlackCLIAPI@1.0','channel_message',{...slackSource().nodes[2].params,...params}))[0].steps[1].kind,'unsupported');
  assert.equal(importDefinitions(source('SlackCLIAPI@1.0','private_channel_message',slackSource().nodes[2].params))[0].steps[1].kind,'unsupported');
  assert.throws(()=>requestFor({kind:'slack_join'},{channel:'G123456',connection:'T'},{T:'synthetic'}),/public Slack/);
});
test('webhook child-object extraction survives compilation and holds missing, array and unsafe selections', async t => {
  const d=reviewed(source('SlackCLIAPI@1.0','channel_message',{channel:'C123456',text:'{{1__message}}'},{key:'event'}));
  assert.equal(validate(d).ready,true);assert.equal(d.steps[0].params.child_key,'event');
  const {id,runner}=setup(t,d);
  const run=await runner.start(id,{event:{message:'Nested payload'}});
  assert.equal(run.status,'succeeded');assert.deepEqual(run.steps[0].output,{message:'Nested payload'});
  for(const input of [{},{event:[]},{event:'text'}])assert.equal((await runner.start(id,input)).status,'held');
  assert.throws(()=>webhookInput({}, {child_key:'constructor'}),/unsafe/);
  assert.deepEqual(webhookInput({'a.b':{ok:true}},{child_key:'a.b'}),{ok:true});
  assert.equal(validate(reviewed(source('SlackCLIAPI@1.0','channel_message',{channel:'C123456',text:'Hello'},{key:'event',unknown:true}))).ready,false);
});
const sheetsSource=(action='add_row')=>source('GoogleSheetsV2CLIAPI@2.14.1',action,{spreadsheet:'spreadsheet_demo',worksheet:0,'COL$A':'{{1__name}}','COL$C':'{{1__amount}}',...(action==='update_row'?{row:'{{1__row}}'}:{})});
test('Sheets append resolves the numeric tab ID, escapes titles, and validates actual formatted cell receipts',async t=>{
  const d=reviewed(sheetsSource()),calls=[];
  assert.equal(d.steps[1].kind,'sheets_append');assert.equal(validate(d).ready,true);
  const {id,runner}=setup(t,d,async r=>{
    calls.push(r);
    if(r.method==='GET')return {sheets:[{properties:{sheetId:1,title:'Wrong'}},{properties:{sheetId:0,title:"Ops'2026"}}]};
    return {spreadsheetId:'spreadsheet_demo',updates:{updatedRange:"'Ops''2026'!A12:C12",updatedRows:1,updatedData:{values:[['Ada','','12.50']]}}};
  });
  const run=await runner.start(id,{name:'Ada',amount:12.5},{mode:'live',key:'append'});
  assert.equal(run.status,'succeeded');assert.equal(calls.length,2);
  assert.equal(calls[0].url,'https://sheets.googleapis.com/v4/spreadsheets/spreadsheet_demo?fields=sheets.properties(sheetId,title)');
  assert.deepEqual(JSON.parse(calls[1].body),{range:"'Ops''2026'!A:C",majorDimension:'ROWS',values:[['Ada',null,12.5]]});
  const url=new URL(calls[1].url);assert.equal(url.searchParams.get('valueInputOption'),'USER_ENTERED');assert.equal(url.searchParams.get('includeValuesInResponse'),'true');
  assert.deepEqual(run.steps.find(s=>s.step_id==='2').output,{id:'12',row:12,'COL$A':'Ada','COL$C':'12.50'});
  const duplicate=await runner.start(id,{name:'Ada',amount:12.5},{mode:'live',key:'append'});
  assert.equal(duplicate.id,run.id);assert.equal(calls.length,2);
  assert.equal(gunzipSync(await bundle(d)).includes(Buffer.from('src/sheets.js')),true);
});
test('Sheets sparse updates touch only mapped columns and use per-cell receipts',async t=>{
  const d=reviewed(sheetsSource('update_row')),calls=[];
  const {id,runner}=setup(t,d,async r=>{
    calls.push(r);
    if(r.method==='GET')return {sheets:[{properties:{sheetId:0,title:'Ops'}}]};
    return {spreadsheetId:'spreadsheet_demo',responses:[{updatedRange:'Ops!A7',updatedRows:1,updatedData:{values:[['Grace']]}},{updatedRange:'Ops!C7',updatedRows:1,updatedData:{values:[[0]]}}]};
  });
  const run=await runner.start(id,{name:'Grace',amount:0,row:7},{mode:'live'});
  assert.equal(run.status,'succeeded');
  assert.deepEqual(JSON.parse(calls[1].body).data,[{range:"'Ops'!A7",majorDimension:'ROWS',values:[['Grace']]},{range:"'Ops'!C7",majorDimension:'ROWS',values:[[0]]}]);
  assert.deepEqual(run.steps.find(s=>s.step_id==='2').output,{id:'7',row:7,'COL$A':'Grace','COL$C':0});
});
test('missing Sheets tab, malformed receipt, non-scalar inputs and unknown export options never yield successful writes',async t=>{
  const d=reviewed(sheetsSource());let calls=0;
  const {id,runner}=setup(t,d,async()=>{calls++;return {sheets:[{properties:{sheetId:999,title:'Other'}}]};});
  assert.equal((await runner.start(id,{name:'N',amount:1},{mode:'live'})).status,'held');assert.equal(calls,1);
  for(const extra of [{timezone:true},{'gsx$name':'Name'},{drive:'some-drive'},{unknown:true}]){
    const raw=sheetsSource();Object.assign(raw.nodes[2].params,extra);
    assert.equal(importDefinitions(raw)[0].steps[1].kind,'unsupported');
  }
  const p={...d.steps[1].params,sheet_title:'Ops',columns:{A:{nested:'object'}}};
  assert.throws(()=>requestFor({kind:'sheets_append'},p,{[p.connection]:'synthetic'}),/scalar/);
  assert.throws(()=>normalizeOutput({kind:'sheets_append'},{spreadsheetId:'different'},p),/another spreadsheet/);
  assert.throws(()=>normalizeOutput({kind:'sheets_append'},{spreadsheetId:p.spreadsheet,updates:{updatedRange:'Ops!A2:A3',updatedRows:2}},p),/one-row receipt/);
});
