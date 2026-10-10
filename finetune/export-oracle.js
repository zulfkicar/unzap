import { isDeepStrictEqual } from 'node:util';
import { validate, compile } from '../src/migration.js';
import { resolve, createContext, parseReference } from '../src/runtime.js';
import { format } from '../src/logic.js';
import { decodeCommand } from './protocol.js';

// Source-tree control flow is evaluated independently of the native graph compiler.
// Scalar reference resolution and formatter codecs are shared; API responses are
// authored contract fixtures, never recordings or live calls.
export function sourceKind(n){
  const app=n.selected_api.split('@')[0];
  if(app==='WebHookCLIAPI')return n.parent_id==null?'webhook':'http';
  if(app==='FilterAPI')return 'filter';
  if(app==='BranchingAPI')return n.action==='branch'?'paths':'path';
  if(app==='ZapierFormatterCLIAPI')return 'formatter';
  if(app==='SlackCLIAPI')return 'slack';
  if(app==='AirtableCLIAPI')return ({findRecord:'airtable_find',createRecord:'airtable',updateRecord:'airtable_update'})[n.action];
  return 'unsupported';
}
const yes=v=>v===true||['true','yes'].includes(String(v).toLowerCase());
export function sourcePredicate(criteria,outputs){
  const groups=new Map();
  for(const c of criteria||[]){
    let key;try{key=resolve(c.key,outputs,{SANDBOX_CREDENTIAL:'sandbox-user:sandbox-pass'});}catch(error){if(c.match==='iexist')key=undefined;else throw error;}
    const value=resolve(c.value,outputs), text=String(key??'').toLowerCase(), needle=String(value??'').toLowerCase();
    let matched;
    switch(c.match){
      case 'iexact':matched=text===needle;break;
      case 'icontains':matched=text.includes(needle);break;
      case 'ireversecontains':matched=needle.includes(text);break;
      case 'istartswith':matched=text.startsWith(needle);break;
      case 'iendswith':matched=text.endsWith(needle);break;
      case 'boolean':if(!['true','false'].includes(text)||!['true','false'].includes(needle))throw Error('Boolean filter has non-boolean data');matched=text===needle;break;
      case 'iexist':matched=key!==undefined&&key!==null&&key!=='';break;
      case 'igreater':case 'iless':{
        if(key==null||key===''||!Number.isFinite(Number(key))||!Number.isFinite(Number(value)))throw Error('Numeric filter has non-numeric data');
        matched=c.match==='igreater'?Number(key)>Number(value):Number(key)<Number(value);break;
      }
      case 'idategreater':case 'idateless':case 'idateequal':{
        const a=Date.parse(key),b=Date.parse(value);if(!Number.isFinite(a)||!Number.isFinite(b))throw Error('Invalid date condition');
        matched=c.match==='idategreater'?a>b:c.match==='idateless'?a<b:a===b;break;
      }
      default:throw Error('Unsupported source condition');
    }
    if(c.action==='stop')matched=!matched;
    const group=Number(c.group??0);if(!groups.has(group))groups.set(group,[]);groups.get(group).push(matched);
  }
  return [...groups.values()].some(g=>g.every(Boolean));
}
export function sourceAction(n,outputs,unresolved=false){
  const p=unresolved?structuredClone(n.params):resolve(n.params,outputs,{SANDBOX_CREDENTIAL:'sandbox-user:sandbox-pass'}),kind=sourceKind(n);
  if(kind==='http')return {url:p.url,method:String(p.method||n.action).toUpperCase(),...(p.data!==undefined?{data:p.data}:{}),...(p.headers?{headers:p.headers}:{}),...(p.auth?{auth:p.auth}:{}),payload_type:p.payload_type||'json',unflatten:yes(p.unflatten),wrap_in_array:yes(p.wrap_in_array)};
  if(kind==='slack'){
    if(n.action==='_zap_raw_request'){const b=typeof p.body==='string'?JSON.parse(p.body):p.body;return {...b};}
    const result={channel:p.channel,text:p.text};
    if(p.unfurl!==undefined)result.unfurl=yes(p.unfurl);
    if(p.link_names!==undefined)result.link_names=yes(p.link_names)?1:0;
    if(p.reply_broadcast!==undefined)result.reply_broadcast=yes(p.reply_broadcast);
    if(p.username)result.username=p.username;
    if(p.thread_ts)result.thread_ts=p.thread_ts;
    if(p.icon_url||String(p.icon||'').startsWith('https://'))result.icon_url=p.icon_url||p.icon;
    else if(p.icon)result.icon_emoji=p.icon;
    if(p.image_url)result.attachments=[{image_url:p.image_url}];
    return result;
  }
  const common={base:p.applicationId,table:p.tableName};
  const fields=p.fields||Object.fromEntries(Object.entries(p).filter(([k])=>k.startsWith('fields__')).map(([k,v])=>[k.slice(8),v]));
  if(kind==='airtable')return {...common,fields};
  if(kind==='airtable_update')return {...common,record:p.rowId,fields};
  if(kind==='airtable_find')return {...common,...(p.searchCriteria?{formula:p.searchCriteria}:{field:p.searchByField,value:p.searchByValue,exact:yes(p.isExactMatch)}),...(p.viewName?{view:p.viewName}:{}),on_missing:yes(p._zap_search_success_on_miss)?'continue':'hold',multiple:p._zap_search_multiple_results||'first'};
  throw Error('Unsupported action receipt');
}
export function sourceExecution(source,fixture){
  const nodes=Object.values(source.nodes), outputs={}, trace=[],calls=[],receipts=[];
  const children=id=>nodes.filter(n=>String(n.parent_id)===String(id));
  const record=(n,status,decision)=>trace.push({step_id:String(n.id),status,...(decision!==undefined?{decision}:{})});
  const skip=n=>{record(n,'skipped');for(const c of children(n.id))skip(c);};
  let completed=false,current;
  function visit(n){
    current=n;const id=String(n.id),kind=sourceKind(n),p=n.params||{};
    if(kind==='paths'){
      outputs[id]={sequential:true};record(n,'succeeded');let matched=false;
      const paths=children(n.id).map((p,i)=>({n:p,i,mode:p.params.path_eval_stage===undefined?'rules':yes(p.params.isAlwaysRun)?'always':'fallback'}));
      paths.sort((a,b)=>(a.mode==='fallback')-(b.mode==='fallback')||Number(a.n.params.path_eval_index??a.i)-Number(b.n.params.path_eval_index??b.i));
      for(const path of paths){current=path.n;const decision=path.mode==='fallback'?!matched:path.mode==='always'?true:sourcePredicate(path.n.params.filter_criteria,outputs);outputs[String(path.n.id)]=decision;record(path.n,'succeeded',decision);
        if(decision){matched=true;const kids=children(path.n.id);if(!kids.length)completed=true;for(const c of kids)visit(c);}else for(const c of children(path.n.id))skip(c);
      }
      return;
    }
    if(kind==='webhook')outputs[id]=fixture.input;
    else if(kind==='filter')outputs[id]=sourcePredicate(p.filter_criteria,outputs);
    else if(kind==='formatter')outputs[id]=format(resolve(p,outputs,{SANDBOX_CREDENTIAL:'sandbox-user:sandbox-pass'}));
    else if(['http','slack','airtable','airtable_find','airtable_update'].includes(kind)){
      // Missing mappings still hold before any simulated action.
      const params=sourceAction(n,outputs);receipts.push({step_id:id,kind,params});
      calls.push(id);outputs[id]=structuredClone(fixture.responses[id]||{id:'rec_sandbox',ok:true,accepted:true,output:'sandbox'});
    }else throw Error('Unsupported source action');
    record(n,'succeeded',kind==='filter'?outputs[id]:undefined);
    const kids=children(n.id);
    if(kind==='filter'&&!outputs[id]){for(const c of kids)skip(c);return;}
    if(!kids.length)completed=true;
    for(const c of kids)visit(c);
  }
  try{const roots=nodes.filter(n=>n.parent_id===null);if(roots.length!==1)throw Error('Source needs one trigger');visit(roots[0]);return {status:completed?'succeeded':'filtered',trace,calls,receipts,outputs};}
  catch(error){if(current)record(current,'held');return {status:'held',trace,calls,receipts,outputs,error:error.message};}
}

export async function judgeExport(task,command){
  if(task.expected_action==='inspect')return {parsed:true,compiler_valid:false,behavior_passed:command?.action==='inspect'&&!command.definition,refusal_passed:command?.action==='inspect'&&!command.definition};
  let d;try{d=decodeCommand(command);}catch(error){return {parsed:true,compiler_valid:false,behavior_passed:false,error:error.message};}
  const pairs=x=>x.map(n=>[String(n.id),n.parent_id==null?null:String(n.parent_id)]).sort();
  if(!isDeepStrictEqual(pairs(Object.values(task.source.nodes)),pairs(d.steps)))return {parsed:true,compiler_valid:false,behavior_passed:false,error:'Source topology changed'};
  const plan=validate(d);if(!plan.ready)return {parsed:true,compiler_valid:false,behavior_passed:false,issues:plan.issues};
  const canonical=v=>{
    if(Array.isArray(v))return v.map(canonical);
    if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,canonical(x)]));
    if(typeof v==='string')return v.replace(/\{\{([^}]+)\}\}/g,(whole,e)=>{const r=parseReference(e);return r?'{{'+JSON.stringify([r.step_id,...r.path])+'}}':whole;});
    return v;
  };
  for(const raw of Object.values(task.source.nodes)){
    const kind=sourceKind(raw),step=d.steps.find(s=>s.id===String(raw.id));
    if(kind==='formatter'&&!isDeepStrictEqual(canonical(raw.params),canonical(step.params)))return {parsed:true,compiler_valid:true,behavior_passed:false,error:'Formatter contract or reference lineage changed'};
    if(['http','slack','airtable','airtable_find','airtable_update'].includes(kind)){
      const {connection,...actual}=step.params;
      if(kind==='http'){actual.method=String(actual.method||'').toUpperCase();actual.payload_type||='json';actual.unflatten=yes(actual.unflatten);actual.wrap_in_array=yes(actual.wrap_in_array);}
      if(!isDeepStrictEqual(canonical(sourceAction(raw,{},true)),canonical(actual)))return {parsed:true,compiler_valid:true,behavior_passed:false,error:'Action contract or reference lineage changed'};
    }
  }
  const module=await import('data:text/javascript;base64,'+Buffer.from(compile(d)).toString('base64'));
  const cases=[];
  for(const fixture of task.fixtures){
    const ctx=createContext({env:{SANDBOX_CREDENTIAL:'sandbox-user:sandbox-pass'}}),calls=[],receipts=[];
    ctx.action=async(step,p)=>{calls.push(String(step.id));const {connection,...params}=p;receipts.push({step_id:String(step.id),kind:step.kind,params});return structuredClone(fixture.responses[String(step.id)]||{id:'rec_sandbox',ok:true,accepted:true,output:'sandbox'});};
    const result=await module.workflow(fixture.input,ctx);
    const trace=result.trace.map(s=>({step_id:s.step_id,status:s.status,...(['path','filter'].includes(s.kind)&&s.status==='succeeded'?{decision:result.outputs[s.step_id]}:{})}));
    const expected=fixture.expected.outputs?fixture.expected:sourceExecution(task.source,fixture);
    const normalized=v=>JSON.parse(JSON.stringify(v));
    const passed=result.status===expected.status&&isDeepStrictEqual(trace,expected.trace)&&isDeepStrictEqual(calls,expected.calls)&&isDeepStrictEqual(receipts,expected.receipts)&&isDeepStrictEqual(normalized(result.outputs),normalized(expected.outputs));
    cases.push({passed,status:result.status,calls,trace,receipts,error:result.error});
  }
  return {parsed:true,compiler_valid:true,behavior_passed:cases.length>0&&cases.every(c=>c.passed),cases};
}

function allRefs(value,output=[]){
  if(typeof value==='string')for(const m of value.matchAll(/\{\{([^}]+)\}\}/g)){const r=parseReference(m[1]);if(r)output.push(r);}
  else if(Array.isArray(value))for(const v of value)allRefs(v,output);
  else if(value&&typeof value==='object')for(const v of Object.values(value))allRefs(v,output);
  return output;
}
export function controlFixtures(source){
  const nodes=Object.values(source.nodes),root=nodes.find(n=>n.parent_id===null),base={input:{},responses:{}};
  if(!root)return [];
  const set=(target,path,value)=>{let t=target;for(const k of path.slice(0,-1)){if(!t[k]||typeof t[k]!=='object')t[k]={};t=t[k];}t[path.at(-1)]=value;};
  const refs=nodes.flatMap(n=>allRefs(n.params));
  for(const r of refs)if(r.step_id===String(root.id))set(base.input,r.path,'sandbox');
  for(const n of nodes)if(['http','slack','airtable','airtable_find','airtable_update'].includes(sourceKind(n))){
    const response={id:'rec_sandbox',channel:'C1000000',ts:'1700000000.000001',ok:true,accepted:true,output:'sandbox',fields:{},_zap_search_was_found_status:false,_zap_search_was_found:false};
    for(const r of refs)if(r.step_id===String(n.id)&&!['_zap_search_was_found_status','_zap_search_was_found','id','channel','ts','ok'].includes(r.path[0]))set(response,r.path,'sandbox');
    base.responses[String(n.id)]=response;
  }
  for(const n of nodes)if(sourceKind(n)==='formatter')for(const r of allRefs(n.params.inputs))if(r.step_id===String(root.id)){
    const t=n.params.transform||'';set(base.input,r.path,t.startsWith('number.')?8:t.startsWith('date.')?(n.params.from_format==='X'?0:'2025-01-01T00:00:00Z'):'  Sandbox  ');
  }
  const axes=new Map(),criteria=nodes.flatMap(n=>n.params?.filter_criteria||[]);
  const add=(r,options)=>{const key=JSON.stringify(r),row=axes.get(key)||{r,options:[]};for(const v of options)if(!row.options.some(x=>Object.is(x,v)))row.options.push(v);axes.set(key,row);};
  for(const c of criteria){
    const m=typeof c.key==='string'?c.key.match(/^\{\{([^}]+)\}\}$/):null,r=m&&parseReference(m[1]);if(!r||(r.step_id!==String(root.id)&&!base.responses[r.step_id]))continue;
    const value=c.value??'', number=Number(value);
    let options=['sandbox','',undefined];
    if(['igreater','iless'].includes(c.match))options=[c.match==='igreater'?number+1:number-1,number,number+1,number-1,0,'invalid'];
    else if(c.match==='boolean')options=[yes(value),!yes(value),0];
    else if(c.match==='iexact')options=[value,'different',String(value).toUpperCase()];
    else if(c.match==='icontains')options=[value,'prefix '+value+' suffix','different'];
    else if(c.match==='istartswith')options=[String(value)+' suffix','different'];
    else if(c.match==='iendswith')options=['prefix '+value,'different'];
    else if(c.match.startsWith('idate'))options=['2025-01-01','2030-01-01','invalid'];
    if(c.action==='stop')options=[options.at(-1),...options];
    add(r,options);
  }
  for(const n of nodes)if(sourceKind(n)==='airtable_find')add({step_id:String(n.id),path:['_zap_search_was_found_status']},[false,true]);
  const apply=(f,r,v)=>set(r.step_id===String(root.id)?f.input:f.responses[r.step_id],r.path,v);
  const rows=[...axes.values()];for(const row of rows)apply(base,row.r,row.options[0]);
  const variations=[structuredClone(base)];
  for(const row of rows)for(const v of row.options){const f=structuredClone(base);apply(f,row.r,v);variations.push(f);}
  for(let mask=0;mask<Math.min(32,2**Math.min(rows.length,5));mask++){
    const f=structuredClone(base);for(let i=0;i<Math.min(rows.length,5);i++)apply(f,rows[i].r,rows[i].options[(mask>>i)&1]??rows[i].options[0]);variations.push(f);
  }
  const fixtures=[],seen=new Set();
  for(const variation of variations){
    const fixture=JSON.parse(JSON.stringify(variation));fixture.expected=sourceExecution(source,fixture);
    const signature=JSON.stringify(fixture);if(seen.has(signature))continue;seen.add(signature);fixtures.push(fixture);
  }
  return fixtures;
}
