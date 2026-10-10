import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { OAuthManager } from '../src/oauth.js';
import { oauthProviders, validateOAuthClient } from '../src/oauth-providers.js';
import { Runner } from '../src/runner.js';
import { oauthConnectForm, oauthSettingsForm } from '../public/oauth-view.js';

const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const originFor=p=>p==='slack'?'https://unzap.example.test':'http://127.0.0.1:8874';
function config(p,extra={}) { return {client_id:'synthetic-client-'+p,client_secret:'synthetic-client-secret',redirect_uri:originFor(p)+'/oauth/callback/'+p,scopes:oauthProviders[p].scopes,...extra}; }
function setup(t,provider='google_sheets') {
  const dir=mkdtempSync(join(tmpdir(),'unzap-oauth-'));
  let store=new Store(dir),time=1700000000000,tokenCount=0;
  const calls=[];
  const fixture={profile:'user-one',scope:null,fail:null,delay:null,missingRefresh:false};
  const fetcher=async(url,options={})=>{
    calls.push({url,...options});
    if(url===oauthProviders[provider].identity)
      return json(provider==='google_sheets'?{sub:fixture.profile,email:'fixture@example.test'}:{id:fixture.profile});
    assert.equal(url,oauthProviders[provider].token);
    const body=new URLSearchParams(options.body);
    if(body.get('grant_type')==='refresh_token'&&fixture.delay)await fixture.delay;
    if(fixture.fail==='network')throw Error('synthetic network interruption');
    if(fixture.fail==='invalid_grant')return json({error:'invalid_grant',error_description:'DO_NOT_RETURN_THIS_SECRET'},400);
    if(fixture.fail==='temporary')return json({error:'temporarily_unavailable'},503);
    tokenCount++;
    return json({...(provider==='slack'?{ok:true,team:{id:'T_SYNTHETIC',name:'Fixture team'},bot_user_id:'U_SYNTHETIC'}:{}),
      access_token:'synthetic-access-'+tokenCount,refresh_token:fixture.missingRefresh?undefined:'synthetic-refresh-'+tokenCount,
      token_type:provider==='slack'?'bot':'Bearer ',expires_in:120,scope:fixture.scope||oauthProviders[provider].scopes.join(provider==='slack'?',':' '),refresh_expires_in:3600});
  };
  let oauth=new OAuthManager(store,{fetcher,now:()=>time});
  oauth.configure(provider,config(provider));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,get store(){return store;},get oauth(){return oauth;},calls,fixture,advance:ms=>time+=ms,
    restart(){store.close();store=new Store(dir);oauth=new OAuthManager(store,{fetcher,now:()=>time});},
    async connect(extra={}){const flow=oauth.begin(provider,{origin:originFor(provider),...extra});const state=new URL(flow.authorization_url).searchParams.get('state');
      return {flow,state,result:await oauth.finish(provider,{origin:originFor(provider),browser:flow.browser,state,code:'synthetic-one-time-code'})};},
  };
}
for(const provider of ['google_sheets','airtable','slack'])test(provider+' completes authorization and persists rotated refresh tokens across restart',async t=>{
  const s=setup(t,provider),{flow,state,result}=await s.connect();
  assert.equal(result.status,'connected');
  const authUrl=new URL(flow.authorization_url),first=s.calls[0],body=new URLSearchParams(first.body);
  assert.equal(first.redirect,'error');assert.equal(body.get('grant_type'),'authorization_code');assert.equal(body.get('redirect_uri'),config(provider).redirect_uri);
  assert.equal(authUrl.searchParams.get('state'),state);
  if(provider!=='slack'){
    assert.equal(authUrl.searchParams.get('code_challenge_method'),'S256');
    assert.equal(authUrl.searchParams.get('code_challenge'),createHash('sha256').update(body.get('code_verifier')).digest('base64url'));
  }
  if(provider==='airtable')assert.equal(first.headers.Authorization,'Basic '+Buffer.from('synthetic-client-airtable:synthetic-client-secret').toString('base64url'));
  if(provider==='google_sheets'){assert.equal(authUrl.searchParams.get('access_type'),'offline');assert.match(authUrl.searchParams.get('prompt'),/consent/);}
  assert.equal(s.store.connections()[0].auth_type,'oauth');
  const visible=JSON.stringify({connections:s.store.connections(),status:s.oauth.status(originFor(provider))});
  assert.ok(!/synthetic-access|synthetic-refresh|synthetic-client-secret/.test(visible));
  const encrypted=JSON.stringify(s.store.db.prepare('SELECT * FROM connections').all());
  assert.ok(!encrypted.includes('synthetic-access')&&!encrypted.includes('synthetic-refresh'));
  s.advance(61000);
  const kind={google_sheets:'sheets_append',airtable:'airtable',slack:'slack'}[provider];
  assert.equal(await s.oauth.accessToken(result.binding,kind),'synthetic-access-2');
  s.restart();s.advance(61000);
  assert.equal(await s.oauth.accessToken(result.binding,kind),'synthetic-access-3');
  const refreshCalls=s.calls.filter(c=>new URLSearchParams(c.body).get('grant_type')==='refresh_token');
  assert.deepEqual(refreshCalls.map(c=>new URLSearchParams(c.body).get('refresh_token')),['synthetic-refresh-1','synthetic-refresh-2']);
});
test('callbacks reject other browsers, origin/provider mismatches, expiry, replay and reused authorization',async t=>{
  const s=setup(t),flow=s.oauth.begin('google_sheets',{origin:originFor('google_sheets')}),state=new URL(flow.authorization_url).searchParams.get('state');
  const base={origin:originFor('google_sheets'),browser:flow.browser,state,code:'code'};
  await assert.rejects(()=>s.oauth.finish('google_sheets',{...base,browser:'x'.repeat(43)}),/another browser/);
  await assert.rejects(()=>s.oauth.finish('airtable',base),/another browser/);
  await assert.rejects(()=>s.oauth.finish('google_sheets',{...base,origin:'https://other.example'}),/origin/);
  assert.equal(s.calls.length,0);
  assert.equal((await s.oauth.finish('google_sheets',base)).status,'connected');
  await assert.rejects(()=>s.oauth.finish('google_sheets',base),/expired|another browser/);
  const count=s.calls.length;
  const expired=s.oauth.begin('google_sheets',{origin:originFor('google_sheets')});s.advance(600001);
  await assert.rejects(()=>s.oauth.finish('google_sheets',{origin:originFor('google_sheets'),browser:expired.browser,state:new URL(expired.authorization_url).searchParams.get('state'),code:'expired'}),/expired/);
  assert.equal(s.calls.length,count);
});
test('denial and logout consume pending requests without token exchange or account changes',async t=>{
  const s=setup(t),flow=s.oauth.begin('google_sheets',{origin:originFor('google_sheets')}),state=new URL(flow.authorization_url).searchParams.get('state');
  const result=await s.oauth.finish('google_sheets',{origin:originFor('google_sheets'),browser:flow.browser,state,error:'access_denied'});
  assert.equal(result.status,'cancelled');assert.equal(s.calls.length,0);assert.equal(s.store.connections().length,0);
  assert.equal(s.oauth.consumeResult(flow.browser).status,'cancelled');assert.equal(s.oauth.consumeResult(flow.browser),null);
  const other=s.oauth.begin('google_sheets',{origin:originFor('google_sheets')});s.oauth.cancelBrowser(other.browser);
  await assert.rejects(()=>s.oauth.finish('google_sheets',{origin:originFor('google_sheets'),browser:other.browser,state:new URL(other.authorization_url).searchParams.get('state'),code:'code'}),/expired/);
});
test('refresh is coalesced but concurrent actions retain independent scope checks',async t=>{
  const s=setup(t,'airtable');s.fixture.scope='data.records:read';const {result}=await s.connect();s.advance(61000);
  let release; s.fixture.delay=new Promise(resolve=>release=resolve);
  const lookup=s.oauth.accessToken(result.binding,'airtable_find');
  const write=s.oauth.accessToken(result.binding,'airtable');
  release();assert.equal(await lookup,'synthetic-access-2');await assert.rejects(()=>write,/permissions/);
  assert.equal(s.calls.filter(c=>new URLSearchParams(c.body).get('grant_type')==='refresh_token').length,1);
});
test('revoked grants and interrupted rotating refreshes are held without replaying the old token',async t=>{
  const s=setup(t,'airtable'),{result}=await s.connect();s.advance(61000);s.fixture.fail='network';
  await assert.rejects(()=>s.oauth.accessToken(result.binding,'airtable'),/interrupted/);
  assert.equal(s.store.connections()[0].oauth_status,'refresh_uncertain');
  const count=s.calls.length;s.restart();s.fixture.fail=null;
  await assert.rejects(()=>s.oauth.accessToken(result.binding,'airtable'),/Reconnect/);assert.equal(s.calls.length,count);
  const repaired=await s.connect({binding:result.binding});assert.equal(repaired.result.status,'connected');
  s.advance(61000);s.fixture.fail='invalid_grant';
  await assert.rejects(()=>s.oauth.accessToken(result.binding,'airtable'),/no longer valid/);
  assert.equal(s.store.connections()[0].oauth_status,'reconnect_required');
  assert.ok(!JSON.stringify(s.oauth.consumeResult(repaired.flow.browser)).includes('DO_NOT_RETURN'));
});
test('Google transient refresh backs off and retries with its reusable refresh token',async t=>{
  const s=setup(t),{result}=await s.connect();s.advance(61000);s.fixture.fail='temporary';
  await assert.rejects(()=>s.oauth.accessToken(result.binding,'sheets_append'),/temporarily/);
  assert.equal(s.store.connections()[0].oauth_status,'retry_later');
  const count=s.calls.length;
  await assert.rejects(()=>s.oauth.accessToken(result.binding,'sheets_append'),/paused/);assert.equal(s.calls.length,count);
  s.advance(30001);s.fixture.fail=null;
  assert.equal(await s.oauth.accessToken(result.binding,'sheets_append'),'synthetic-access-2');
});
test('database refresh leases prevent a second manager from consuming a rotating token and recover interrupted leases safely',async t=>{
  const s=setup(t,'airtable'),{result}=await s.connect();s.advance(61000);
  let release;s.fixture.delay=new Promise(resolve=>release=resolve);
  const first=s.oauth.accessToken(result.binding,'airtable');
  const other=new OAuthManager(s.store,{fetcher:async()=>{throw Error('No second token request allowed');},now:()=>1700000061000});
  await assert.rejects(()=>other.accessToken(result.binding,'airtable'),/in progress/);
  release();assert.equal(await first,'synthetic-access-2');
  s.store.db.prepare("UPDATE connections SET oauth_status='refreshing',refresh_started_at=0 WHERE binding=?").run(result.binding);
  const count=s.calls.length;s.restart();
  assert.equal(s.store.connections()[0].oauth_status,'refresh_uncertain');
  await assert.rejects(()=>s.oauth.accessToken(result.binding,'airtable'),/Reconnect/);assert.equal(s.calls.length,count);
});
test('public PKCE clients omit client secrets, and app changes invalidate pending sign-in',async t=>{
  const s=setup(t,'slack');s.oauth.configure('slack',config('slack',{pkce:true,client_secret:''}));
  const {result,flow}=await s.connect();assert.equal(result.status,'connected');
  assert.equal(new URL(flow.authorization_url).searchParams.get('code_challenge_method'),'S256');
  assert.equal(new URLSearchParams(s.calls[0].body).has('client_secret'),false);
  s.advance(61000);await s.oauth.accessToken(result.binding,'slack');
  assert.equal(new URLSearchParams(s.calls.at(-1).body).has('client_secret'),false);
  const pending=s.oauth.begin('slack',{origin:originFor('slack')});
  s.oauth.configure('slack',config('slack',{pkce:true}));
  const count=s.calls.length;
  const changed=await s.oauth.finish('slack',{origin:originFor('slack'),browser:pending.browser,state:new URL(pending.authorization_url).searchParams.get('state'),code:'code'});
  assert.equal(changed.status,'failed');assert.match(changed.message,/settings changed/);assert.equal(s.calls.length,count);
});
test('reconnect verifies identity and cannot overwrite a removed or changed account',async t=>{
  const s=setup(t),{result}=await s.connect();s.fixture.profile='different-user';
  const wrong=await s.connect({binding:result.binding});assert.equal(wrong.result.status,'failed');assert.match(wrong.result.message,/different account/);
  assert.equal(s.store.secrets()[result.binding],'synthetic-access-1');
  const flow=s.oauth.begin('google_sheets',{origin:originFor('google_sheets'),binding:result.binding});
  s.store.connect(result.binding,'Manual replacement','synthetic-manual-secret','google_sheets');
  const changed=await s.oauth.finish('google_sheets',{origin:originFor('google_sheets'),browser:flow.browser,state:new URL(flow.authorization_url).searchParams.get('state'),code:'code'});
  assert.equal(changed.status,'failed');assert.match(changed.message,/changed/);assert.equal(s.store.secrets()[result.binding],'synthetic-manual-secret');
});
test('runner refreshes before live writes and mock replay makes no OAuth requests',async t=>{
  const s=setup(t,'airtable'),{result}=await s.connect();s.advance(61000);
  const d={name:'OAuth execution',steps:[{id:'1',parent_id:null,kind:'webhook',params:{}},{id:'2',parent_id:'1',kind:'airtable',params:{base:'app_fixture',table:'Records',connection:result.binding,fields:{Name:'{{1__name}}'}}}]};
  const id=s.store.add(d),requests=[];
  const runner=new Runner(s.store,{oauth:s.oauth,transport:async r=>{requests.push(r);return{records:[{id:'rec_fixture',fields:{Name:'Ada'}}]};}});
  const count=s.calls.length;
  assert.equal((await runner.start(id,{name:'Ada'},{mode:'mock'})).status,'succeeded');assert.equal(s.calls.length,count);
  assert.equal((await runner.start(id,{name:'Ada'},{mode:'live'})).status,'succeeded');
  assert.equal(requests[0].headers.Authorization,'Bearer synthetic-access-2');
  assert.ok(!JSON.stringify(s.store.run(s.store.db.prepare("SELECT id FROM runs WHERE mode='live'").get().id)).includes('synthetic-access-2'));
  s.advance(61000);s.fixture.fail='invalid_grant';
  assert.equal((await runner.start(id,{name:'Ada'},{mode:'live'})).status,'held');assert.equal(requests.length,1);
});
test('invalid clients, scopes, callback URLs and oversized provider responses cannot create accounts',async t=>{
  assert.throws(()=>validateOAuthClient('slack',config('slack',{redirect_uri:'http://127.0.0.1:8874/oauth/callback/slack'})),/HTTPS/);
  for(const redirect_uri of ['https://user:pass@example.test/oauth/callback/google_sheets','http://remote.example.test/oauth/callback/google_sheets','https://example.test/oauth/callback/google_sheets#fragment'])
    assert.throws(()=>validateOAuthClient('google_sheets',config('google_sheets',{redirect_uri})),/HTTPS|callback/);
  assert.throws(()=>validateOAuthClient('google_sheets',config('google_sheets',{scopes:['openid']})),/identity|email|Sheets/);
  const s=setup(t);await assert.rejects(()=>s.oauth.json(new Response('x'.repeat(65537))),/oversized/);
  s.fixture.missingRefresh=true;const result=await s.connect();assert.equal(result.result.status,'failed');assert.equal(s.store.connections().length,0);
});
test('OAuth HTTP routes protect setup/start and bind unauthenticated callbacks to the initiating browser',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'unzap-oauth-api-')),token='synthetic-control-oauth-tests';
  const child=spawn(process.execPath,['src/server.js'],{cwd:process.cwd(),env:{...process.env,DATA_DIR:dir,CONTROL_TOKEN:token,HOST:'127.0.0.1',PORT:'0'},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}rmSync(dir,{recursive:true,force:true});});
  const ready=await once(child.stdout,'data'),origin='http://127.0.0.1:'+JSON.parse(String(ready[0])).port;
  const headers={Authorization:'Bearer '+token,Origin:origin,'Content-Type':'application/json'};
  const post=(path,body,extra={})=>fetch(origin+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  assert.equal((await fetch(origin+'/api/oauth/status')).status,401);
  assert.equal((await fetch(origin+'/oauth-view.js')).status,200);
  const settings=await post('/api/oauth/clients/google_sheets',{...config('google_sheets'),redirect_uri:origin+'/oauth/callback/google_sheets'});
  assert.equal(settings.status,200);assert.ok(!(await settings.text()).includes('synthetic-client-secret'));
  assert.equal((await post('/api/oauth/start/google_sheets',{}, {Origin:'https://other.example'})).status,403);
  const start=await post('/api/oauth/start/google_sheets',{}),url=new URL((await start.json()).authorization_url),cookie=start.headers.get('set-cookie');
  assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Lax/);
  const callback=origin+'/oauth/callback/google_sheets?state='+url.searchParams.get('state')+'&error=access_denied';
  assert.equal((await fetch(callback,{redirect:'manual'})).status,400);
  const response=await fetch(callback,{headers:{Cookie:cookie.split(';')[0]},redirect:'manual'});
  assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/#connections');
  assert.equal((await fetch(callback,{headers:{Cookie:cookie.split(';')[0]},redirect:'manual'})).status,400);
  const outcome=await fetch(origin+'/api/oauth/result',{headers:{...headers,Cookie:cookie.split(';')[0]}});
  assert.equal((await outcome.json()).result.status,'cancelled');
});
test('OAuth screens distinguish owner app setup from end-user sign-in and omit personal-token inputs',()=>{
  const fake={providers:{google_sheets:{label:'Google Sheets'}},oauth:{google_sheets:{label:'Google',available:false,configured:false,reason:'OAuth app setup required',scopes:oauthProviders.google_sheets.scopes,allowed_scopes:oauthProviders.google_sheets.scopes,instructions:['Register your app once.'],setup:'https://console.cloud.google.com/apis/credentials',redirect_uri:config('google_sheets').redirect_uri,client_id:'',secret_set:false}}};
  assert.match(oauthConnectForm(fake,{provider:'google_sheets'}),/Continue with Google/);
  assert.match(oauthConnectForm(fake,{provider:'google_sheets'}),/disabled/);
  assert.doesNotMatch(oauthConnectForm(fake,{provider:'google_sheets'}),/name="secret"/);
  assert.match(oauthSettingsForm(fake,'google_sheets'),/Callback URL/);
  assert.match(oauthSettingsForm(fake,'google_sheets'),/Client secret/);
});
