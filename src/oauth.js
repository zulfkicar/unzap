import { randomBytes, createHash } from 'node:crypto';
import { oauthProviders, callbackUrl, validateOAuthClient, requiredScopes } from './oauth-providers.js';
import { prepareOAuthStore } from './oauth-store.js';
import { accountBinding, connectionProvider } from './accounts.js';
const hash=v=>createHash('sha256').update(v).digest('hex');
const random=()=>randomBytes(32).toString('base64url');
const validToken=v=>typeof v==='string'&&v.length>0&&v.length<=10000;
export class OAuthManager {
  constructor(store,{fetcher=fetch,now=()=>Date.now()}={}) {
    this.store=store;this.fetcher=fetcher;this.now=now;this.pending=new Map();
    prepareOAuthStore(store);
    // A rotating refresh may have succeeded remotely before this process died.
    // Never submit the old refresh token again after an interrupted exchange.
    store.db.prepare("UPDATE connections SET oauth_status='refresh_uncertain' WHERE auth_type='oauth' AND oauth_status='refreshing' AND (refresh_started_at IS NULL OR refresh_started_at<?)").run(now()-30000);
    store.db.prepare('DELETE FROM oauth_flows WHERE expires_at<?').run(now()-3600000);
  }
  client(provider) {
    const row=this.store.db.prepare('SELECT * FROM oauth_clients WHERE provider=?').get(provider);
    return row?{...this.store.open(row.config),version:row.version}:null;
  }
  configure(provider, input) {
    const old=this.client(provider);
    if (old&&input.client_id!==old.client_id&&!input.client_secret&&!(provider==='airtable'||provider==='slack'&&input.pkce)) throw Error('Enter the secret for the new OAuth client');
    const config=validateOAuthClient(provider,{...input,client_secret:input.client_secret||(input.client_id?.trim()===old?.client_id?old?.client_secret:'')||''});
    this.store.db.prepare('INSERT INTO oauth_clients VALUES(?,?,?,?) ON CONFLICT(provider) DO UPDATE SET config=excluded.config,version=excluded.version,updated_at=excluded.updated_at')
      .run(provider,this.store.seal(config),(old?.version||0)+1,new Date(this.now()).toISOString());
    return this.status(new URL(config.redirect_uri).origin)[provider];
  }
  status(origin) {
    return Object.fromEntries(Object.entries(oauthProviders).map(([id,p])=>{
      const config=this.client(id), localReady=p.localhost||new URL(origin).protocol==='https:';
      const sameOrigin=!config||new URL(config.redirect_uri).origin===origin;
      return [id,{label:p.label,configured:!!config,available:!!config&&localReady&&sameOrigin,
        reason:!localReady?'HTTPS deployment required':!config?'OAuth app setup required':!sameOrigin?'Open Unzap at the registered callback origin':null,
        redirect_uri:config?.redirect_uri||callbackUrl(id,origin),client_id:config?.client_id||'',secret_set:!!config?.client_secret,
        pkce:config?.pkce??p.pkce,scopes:config?.scopes||p.scopes,allowed_scopes:[...p.scopes,...(p.optionalScopes||[])],setup:p.setup,instructions:p.instructions}];
    }));
  }
  begin(provider,{origin,browser,label='',binding=null,workflow_id=null,step_id=null}={}) {
    const state=this.status(origin)[provider];
    if (!state?.available) throw Error(state?.reason||'Unknown OAuth app');
    const config=this.client(provider);
    if (binding) {
      const row=this.store.connections().find(c=>c.binding===binding);
      if (!row||row.provider!==provider) throw Error('Reconnect an account belonging to this app');
      const lease=this.store.db.prepare('SELECT oauth_status,refresh_started_at FROM connections WHERE binding=?').get(binding);
      if(lease.oauth_status==='refreshing'&&lease.refresh_started_at>this.now()-30000)throw Error('A refresh is in progress. Wait before reconnecting.');
    }
    if (workflow_id) {
      const w=this.store.get(workflow_id);
      if (!w||!w.definition.steps.some(s=>s.id===step_id&&connectionProvider(s.kind)===provider)) throw Error('Invalid workflow connection context');
    }
    const browserKey=/^[A-Za-z0-9_-]{43}$/.test(browser||'')?browser:random();
    const nonce=random(),verifier=random(),payload={provider,label:String(label).slice(0,120),binding,workflow_id,step_id,
      origin,verifier,client_version:config.version,credential_version:binding?this.store.db.prepare('SELECT credential_version FROM connections WHERE binding=?').get(binding).credential_version:null};
    this.store.db.prepare('INSERT INTO oauth_flows(id,provider,browser_hash,payload,expires_at) VALUES(?,?,?,?,?)')
      .run(hash(nonce),provider,hash(browserKey),this.store.seal(payload),this.now()+600000);
    const url=new URL(oauthProviders[provider].authorize);
    url.searchParams.set('client_id',config.client_id);url.searchParams.set('redirect_uri',config.redirect_uri);url.searchParams.set('state',nonce);
    url.searchParams.set('scope',config.scopes.join(provider==='slack'?',':' '));
    if (provider!=='slack')url.searchParams.set('response_type','code');
    if (config.pkce) {url.searchParams.set('code_challenge',createHash('sha256').update(verifier).digest('base64url'));url.searchParams.set('code_challenge_method','S256');}
    if (provider==='google_sheets'){url.searchParams.set('access_type','offline');url.searchParams.set('prompt','consent select_account');url.searchParams.set('include_granted_scopes','true');}
    return {authorization_url:url.toString(),browser:browserKey};
  }
  async request(provider,params,config) {
    const p=oauthProviders[provider],body=new URLSearchParams(params),headers={'Content-Type':'application/x-www-form-urlencoded'};
    if (provider==='airtable'&&config.client_secret) headers.Authorization='Basic '+Buffer.from(config.client_id+':'+config.client_secret).toString('base64url');
    else {body.set('client_id',config.client_id);if(config.client_secret&&!(provider==='slack'&&config.pkce))body.set('client_secret',config.client_secret);}
    let response;
    try {response=await this.fetcher(p.token,{method:'POST',headers,body:body.toString(),redirect:'error',signal:AbortSignal.timeout(15000)});}
    catch {throw Object.assign(Error(provider==='google_sheets'?'Google token renewal was interrupted. It will retry after a short pause.':'OAuth token exchange was interrupted. Reconnect before retrying a rotating token.'),{oauthStatus:provider==='google_sheets'?'retry_later':'refresh_uncertain'});}
    if(response.status===429||response.status>=500){
      await response.body?.cancel();
      throw Object.assign(Error('The OAuth provider is temporarily unavailable. Renewal has been paused.'),{oauthStatus:provider==='google_sheets'?'retry_later':'refresh_uncertain'});
    }
    const data=await this.json(response);
    if (!response.ok||data.error||provider==='slack'&&data.ok!==true) {
      const known=['invalid_grant','invalid_client','token_revoked','invalid_refresh_token'].includes(data.error);
      throw Object.assign(Error(known?'OAuth authorization is no longer valid. Reconnect this account.':'The provider rejected OAuth token exchange. Check app setup and reconnect.'),{oauthStatus:'reconnect_required'});
    }
    return data;
  }
  async json(response) {
    const bytes=[];let size=0;
    try {
      for await(const part of response.body){size+=part.length;if(size>65536)throw Error('limit');bytes.push(Buffer.from(part));}
      const value=JSON.parse(Buffer.concat(bytes).toString('utf8'));
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('shape');
      return value;
    }catch{throw Object.assign(Error('OAuth provider returned an unreadable or oversized response. Reconnect this account.'),{oauthStatus:'refresh_uncertain'});}
  }
  normalize(provider,data,previous=null) {
    if(!validToken(data.access_token))throw Error('OAuth response has no access token');
    if(provider==='slack'?data.token_type!=='bot':String(data.token_type||'').trim().toLowerCase()!=='bearer')throw Error('OAuth provider returned an unsupported token type');
    const expires=data.expires_in;
    if(expires!==undefined&&(!Number.isInteger(expires)||expires<=0||expires>2678400))throw Error('OAuth provider returned an invalid expiry');
    if(expires===undefined&&provider!=='slack')throw Error('OAuth provider did not return an expiry');
    const refresh=data.refresh_token||previous?.refresh_token;
    const refreshExpires=data.refresh_expires_in??data.refresh_token_expires_in;
    if(refreshExpires!==undefined&&(!Number.isSafeInteger(refreshExpires)||refreshExpires<=0||refreshExpires>315360000))throw Error('OAuth provider returned an invalid refresh expiry');
    if(expires!==undefined&&!validToken(refresh))throw Error('OAuth provider did not issue a refresh token. Reconnect with offline access.');
    if(previous&&['airtable','slack'].includes(provider)&&(!validToken(data.refresh_token)||data.refresh_token===previous.refresh_token))throw Error('Rotating OAuth response has no new refresh token');
    return {access_token:data.access_token,refresh_token:refresh||null,expires_at:expires===undefined?null:this.now()+expires*1000,
      scopes:typeof data.scope==='string'?data.scope.split(/[ ,]+/).filter(Boolean):previous?.scopes||[],
      refresh_expires_at:refreshExpires===undefined?previous?.refresh_expires_at||null:this.now()+refreshExpires*1000};
  }
  async identity(provider,data,token) {
    if(provider==='slack'){
      if(typeof data.team?.id!=='string'||!data.team.id||data.team.id.length>255||typeof data.bot_user_id!=='string'||!data.bot_user_id||data.bot_user_id.length>255)throw Error('Slack OAuth response has no workspace and bot identity');
      return {id:data.team.id+':'+data.bot_user_id,label:String(data.team.name||'Slack workspace').slice(0,120)};
    }
    let response;
    try{response=await this.fetcher(oauthProviders[provider].identity,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw Error('Could not confirm the connected account identity. Reconnect.');}
    if(!response.ok)throw Error('Could not confirm the connected account identity. Reconnect.');
    const profile=await this.json(response),id=provider==='google_sheets'?profile.sub:profile.id;
    if(typeof id!=='string'||!id||id.length>255)throw Error('Provider identity response is incomplete');
    return {id,label:provider==='google_sheets'?String(profile.email||'Google Sheets account').slice(0,120):'Airtable account'};
  }
  async finish(provider,{state,browser,origin,code,error}={}) {
    const db=this.store.db;
    if(!/^[A-Za-z0-9_-]{43}$/.test(state||'')||!/^[A-Za-z0-9_-]{43}$/.test(browser||''))throw Error('OAuth request expired or belongs to another browser. Start again.');
    const row=db.prepare('SELECT * FROM oauth_flows WHERE id=?').get(hash(state));
    if(!row||row.provider!==provider||row.browser_hash!==hash(browser)||row.expires_at<this.now()||row.consumed)throw Error('OAuth request expired or belongs to another browser. Start again.');
    const flow=this.store.open(row.payload);
    if(flow.origin!==origin)throw Error('OAuth callback origin does not match this request');
    if(!db.prepare('UPDATE oauth_flows SET consumed=1,payload=NULL WHERE id=? AND consumed=0').run(row.id).changes)throw Error('OAuth callback already used');
    let result;
    try {
      if(error)throw Error(error==='access_denied'?'Sign-in cancelled. No account was changed.':'The provider declined sign-in. Check OAuth setup.');
      if(typeof code!=='string'||!code||code.length>4096)throw Error('OAuth callback has no authorization code');
      const config=this.client(provider);
      if(!config||config.version!==flow.client_version)throw Error('OAuth app settings changed during sign-in. Start again.');
      const old=flow.binding?db.prepare('SELECT * FROM connections WHERE binding=?').get(flow.binding):null;
      if(flow.binding&&(!old||old.credential_version!==flow.credential_version))throw Error('Account changed during sign-in. Start again.');
      const previous=old?.oauth?this.store.open(old.oauth):null;
      const data=await this.request(provider,{grant_type:'authorization_code',code,redirect_uri:config.redirect_uri,...(config.pkce?{code_verifier:flow.verifier}:{})},config);
      const tokens=this.normalize(provider,data,previous),identity=await this.identity(provider,data,tokens.access_token);
      if(previous?.identity?.id&&previous.identity.id!==identity.id)throw Error('This is a different account. Add it separately instead of reconnecting.');
      const binding=flow.binding||accountBinding(provider,flow.label||identity.label);
      this.store.transaction(()=>{
        if(old){
          const changed=db.prepare("UPDATE connections SET secret=?,oauth=?,auth_type='oauth',oauth_status='connected',credential_version=credential_version+1 WHERE binding=? AND credential_version=?")
            .run(this.store.seal(tokens.access_token),this.store.seal({...tokens,access_token:undefined,identity,client_id:config.client_id}),binding,flow.credential_version).changes;
          if(!changed)throw Error('Account changed during sign-in. Start again.');
        }else{
          this.store.connect(binding,flow.label||identity.label,tokens.access_token,provider);
          db.prepare("UPDATE connections SET auth_type='oauth',oauth_status='connected',oauth=? WHERE binding=?")
            .run(this.store.seal({...tokens,access_token:undefined,identity,client_id:config.client_id}),binding);
        }
      });
      result={status:'connected',binding,workflow_id:flow.workflow_id,step_id:flow.step_id};
    }catch(e){result={status:error==='access_denied'?'cancelled':'failed',message:e.message,workflow_id:flow.workflow_id};}
    db.prepare('UPDATE oauth_flows SET result=? WHERE id=?').run(this.store.seal(result),row.id);
    return result;
  }
  consumeResult(browser) {
    if(!browser)return null;
    return this.store.transaction(()=>{
      const row=this.store.db.prepare('SELECT id,result FROM oauth_flows WHERE browser_hash=? AND result IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(hash(browser));
      if(!row)return null;
      this.store.db.prepare('UPDATE oauth_flows SET result=NULL WHERE id=?').run(row.id);
      return this.store.open(row.result);
    });
  }
  cancelBrowser(browser) {
    if(browser)this.store.db.prepare('UPDATE oauth_flows SET consumed=1,payload=NULL,result=NULL WHERE browser_hash=?').run(hash(browser));
  }
  async accessToken(binding,kind,params={}) {
    let promise=this.pending.get(binding),owned=false;
    if(!promise){promise=this.refresh(binding,kind,params);this.pending.set(binding,promise);owned=true;}
    try {
      await promise;
      // Recheck each waiter's permissions and current credential. A different
      // action cannot borrow the initiating action's scope check.
      const row=this.store.db.prepare('SELECT * FROM connections WHERE binding=?').get(binding);
      if(!row)throw Error('Account was removed');
      if(row.auth_type==='oauth'){
        const meta=this.store.open(row.oauth);
        if(row.oauth_status!=='connected'||connectionProvider(kind)&&connectionProvider(kind)!==row.provider||requiredScopes(kind,params).some(s=>!meta.scopes.includes(s)))
          throw Error('Reconnect this account with the required permissions');
      }
      return this.store.open(row.secret);
    }finally{if(owned)this.pending.delete(binding);}
  }
  async refresh(binding,kind,params) {
    const db=this.store.db;let row=db.prepare('SELECT * FROM connections WHERE binding=?').get(binding);
    if(!row)throw Error('Configure the account before running this action');
    if(row.auth_type!=='oauth')return this.store.open(row.secret);
    if(row.oauth_status==='retry_later'){
      if(row.refresh_retry_at>this.now())throw Error('OAuth renewal is paused briefly. Resume after the provider recovers.');
      db.prepare("UPDATE connections SET oauth_status='connected' WHERE binding=? AND credential_version=? AND oauth_status='retry_later'").run(binding,row.credential_version);
      row=db.prepare('SELECT * FROM connections WHERE binding=?').get(binding);
    }
    if(connectionProvider(kind)&&connectionProvider(kind)!==row.provider)throw Error('Account belongs to a different app');
    if(row.oauth_status==='refreshing'&&row.refresh_started_at<this.now()-30000){
      db.prepare("UPDATE connections SET oauth_status='refresh_uncertain' WHERE binding=? AND credential_version=? AND oauth_status='refreshing'").run(binding,row.credential_version);
      row=db.prepare('SELECT * FROM connections WHERE binding=?').get(binding);
    }
    if(row.oauth_status==='refreshing')throw Error('Account refresh is already in progress. Resume after it completes.');
    if(row.oauth_status!=='connected')throw Error('Reconnect this account before running. OAuth status: '+row.oauth_status);
    const meta=this.store.open(row.oauth);
    if(requiredScopes(kind,params).some(s=>!meta.scopes.includes(s)))throw Error('The account needs additional permissions. Reconnect with the required scopes.');
    if(meta.expires_at===null||meta.expires_at>this.now()+60000)return this.store.open(row.secret);
    const config=this.client(row.provider);
    if(!config||config.client_id!==meta.client_id)throw Error('The OAuth application changed. Reconnect this account.');
    if(!meta.refresh_token||meta.refresh_expires_at&&meta.refresh_expires_at<this.now()){
      db.prepare("UPDATE connections SET oauth_status='reconnect_required' WHERE binding=? AND credential_version=?").run(binding,row.credential_version);
      throw Error('The refresh authorization expired. Reconnect this account.');
    }
    if(!db.prepare("UPDATE connections SET oauth_status='refreshing',refresh_started_at=? WHERE binding=? AND credential_version=? AND oauth_status='connected'").run(this.now(),binding,row.credential_version).changes)throw Error('Account refresh is already in progress. Resume after it completes.');
    try {
      const data=await this.request(row.provider,{grant_type:'refresh_token',refresh_token:meta.refresh_token},config),tokens=this.normalize(row.provider,data,meta);
      if(!db.prepare("UPDATE connections SET secret=?,oauth=?,oauth_status='connected',credential_version=credential_version+1 WHERE binding=? AND credential_version=? AND oauth_status='refreshing'")
        .run(this.store.seal(tokens.access_token),this.store.seal({...meta,...tokens,access_token:undefined}),binding,row.credential_version).changes)throw Error('Account changed while refreshing');
      return tokens.access_token;
    }catch(e){
      db.prepare('UPDATE connections SET oauth_status=?,refresh_retry_at=? WHERE binding=? AND credential_version=? AND oauth_status=\'refreshing\'').run(e.oauthStatus||'refresh_uncertain',e.oauthStatus==='retry_later'?this.now()+30000:null,binding,row.credential_version);
      throw e;
    }
  }
  startMaintenance() {
    let running=false;
    const timer=setInterval(async()=>{
      if(running)return;running=true;
      try {
      const used=new Set();
      for(const w of this.store.list())if(w.active_version&&w.mode==='live')
        for(const s of this.store.get(w.id,w.active_version).definition.steps)if(s.params.connection)used.add(s.params.connection);
      for(const c of this.store.connections())if(used.has(c.binding)&&c.auth_type==='oauth'&&['connected','retry_later'].includes(c.oauth_status)&&c.expires_at&&c.expires_at<this.now()+60000)
        try{await this.accessToken(c.binding,'oauth_refresh');}catch{/* Status is persisted for the UI. No provider writes are retried. */}
      }finally{running=false;}
    },30000);
    timer.unref();return()=>clearInterval(timer);
  }
}
