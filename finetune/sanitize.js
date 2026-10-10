import { parseReference } from '../src/runtime.js';
import { formatterContracts, conditionOperators } from '../src/logic.js';

// Only protocol vocabulary survives. Customer keys, values and IDs are replaced.
const structural = new Set(`url method headers data payload_type unflatten wrap_in_array auth file as_json json_key pass_through key filter_criteria group match value action transform inputs separator index old new find use_plus default_value max_length append_ellipsis operation default table fallback from_format to_format from_timezone to_timezone applicationId tableName fields rowId appendAttachments isExactMatch _zap_search_success_on_miss searchByValue searchByField viewName searchCriteria _zap_search_multiple_results channel text as_bot add_edit_link unfurl link_names reply_broadcast username icon icon_url thread_ts image_url post_at add_app_to_channel emoji color ignore_dependency_errors path_eval_index path_eval_stage savedFilterCriteria formerTitle isAlwaysRun body fail_on_errors blocks attachments type elements accessory title block_id alt_text image_url text mrkdwn Content-Type Authorization Accept content-type authorization content_type $env`.split(' '));
const reserved = new Set(['id','fields','output','_zap_search_was_found_status','_zap_search_was_found','channel','ts','message','ok','status','body','records']);
const publicEnums = new Set([...Object.keys(formatterContracts), ...conditionOperators,'date.formatting','X','x','YYYY-MM-DD','YYYY-MM-DDTHH:mm:ssZ','ISO','UTC','Asia/Karachi','America/New_York','GET','POST','PUT','PATCH','DELETE','json','form','raw','first','last','all','fields','halt','hold','continue','stop','add','sub','mul','div','true','false','yes','no','application/json','mrkdwn','plain_text','section','image','context','divider']);
const appActions = {
  WebHookCLIAPI: new Set(['hook','hook_v2','get','post','put','custom']),
  SlackCLIAPI: new Set(['channel_message','private_channel_message','_zap_raw_request']),
  AirtableCLIAPI: new Set(['createRecord','updateRecord','findRecord']),
  ZapierFormatterCLIAPI: new Set(['text_line_item','number_line_item','util_line_item','date_time']),
  FilterAPI: new Set(['filter']), BranchingAPI: new Set(['branch','filter']),
};
export function sanitizeWorkflow(workflow, { extended = false } = {}) {
  const raw=Object.values(workflow.nodes||{}), ids=new Map(raw.map((n,i)=>[String(n.id),String(i+1)]));
  const originalIds=new Set(ids.keys()), aliases=new Map(), ambiguous=new Set();
  for(const n of raw) for(const alias of [n.triple_stores?.copied_from,n.meta?.$editor?.replaced_step_id]){
    if(alias==null||originalIds.has(String(alias)))continue;
    const key=String(alias), target=ids.get(String(n.id));
    if(aliases.has(key)&&aliases.get(key)!==target)ambiguous.add(key);
    aliases.set(key,target);
  }
  for(const [key,target] of aliases)if(!ambiguous.has(key))ids.set(key,target);
  const unresolved=new Map();
  const fields=new Map(), literals=new Map(), groups=new Map();
  const field = (s) => reserved.has(s)||extended&&/^COL\$[A-Z]{1,3}$/.test(s)||/^\d+$/.test(s)&&Number(s)<=500 ? s : fields.get(s) || (fields.set(s,'field_'+(fields.size+1)),fields.get(s));
  const literal = (s,prefix='value') => literals.get(prefix+':'+s) || (literals.set(prefix+':'+s,prefix+'_'+(literals.size+1)),literals.get(prefix+':'+s));
  const ref = (expression) => {
    const parsed=parseReference(expression);
    if(!parsed) return '{{=unsupported_expression}}';
    const id=ids.get(parsed.step_id)||unresolved.get(parsed.step_id)||(unresolved.set(parsed.step_id,String(9000+unresolved.size)),unresolved.get(parsed.step_id));
    return '{{=gives'+[id,...parsed.path.map(field)].map(v=>'['+JSON.stringify(v)+']').join('')+'}}';
  };
  function clean(v,path=[],dynamic=false){
    const key=path.at(-1)||'';
    if(key==='group'&&(v===null||typeof v!=='object')){const g=String(v??0);if(!groups.has(g))groups.set(g,groups.size);return groups.get(g);}
    if(Array.isArray(v))return v.map(x=>clean(x,path,dynamic));
    if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>{
      let next=(structural.has(k)||extended&&['spreadsheet','worksheet','row','drive','timezone','Pick off a Child Key'].includes(k))&&!dynamic?k:field(k);
      if(k.startsWith('fields__'))next='fields__'+field(k.slice(8));
      return [next,clean(x,[...path,k],dynamic||['data','fields','table','headers'].includes(key)&&key!=='headers')];
    }));
    if(v===null||v===''||typeof v==='boolean')return v;
    if(typeof v==='number'){
      if(['group','path_eval_index'].includes(key))return Number.isInteger(v)&&v>=0&&v<=500?v:-1;
      if(key==='path_eval_stage')return [1,9].includes(v)?v:-1;
      if(key==='link_names')return [0,1].includes(v)?v:0;
      return Number(literal(String(v),'number').split('_').at(-1))+10;
    }
    if(typeof v!=='string')return null;
    if(extended&&['worksheet','row'].includes(key)&&/^\d+$/.test(v))return String(Number(literal(v,'number').split('_').at(-1))+10);
    if(extended&&['key','Pick off a Child Key'].includes(key)&&!v.includes('{{'))return field(v);
    if(/(?:authorization|password|secret|api[_-]?key|access[_-]?token|token|auth)$/i.test(key)&&!v.includes('{{'))return {$env:'SANDBOX_CREDENTIAL'};
    if(['body','data'].includes(key)&&v.trim().startsWith('{'))try{return JSON.stringify(clean(JSON.parse(v),path,key==='data'));}catch{}
    if(['transform','match','method','payload_type','operation','action','from_format','to_format','from_timezone','to_timezone','_zap_search_multiple_results','Content-Type','content-type','type'].includes(key))return publicEnums.has(v)?v:'unsupported_option';
    if(key==='index')return ['fields','all'].includes(v)?v:/^-?\d+$/.test(v)&&Math.abs(Number(v))<=50?v:'unsupported_option';
    if(['as_bot','add_edit_link','unfurl','link_names','reply_broadcast','appendAttachments','isExactMatch','_zap_search_success_on_miss','unflatten','wrap_in_array','as_json','pass_through','ignore_dependency_errors','isAlwaysRun','fail_on_errors','add_app_to_channel','use_plus','append_ellipsis'].includes(key)&&['true','false','yes','no'].includes(v.toLowerCase()))return v.toLowerCase();
    if(['path_eval_index','group'].includes(key)&&/^\d+$/.test(v))return Number(v)<=500?v:'-1';
    if(key==='path_eval_stage'&&/^\d+$/.test(v))return ['1','9'].includes(v)?v:'-1';
    if(v.includes('{{')&&key==='url')return 'https://example.test/'+literal(v,'endpoint')+'?'+[...v.matchAll(/\{\{([^}]+)\}\}/g)].map((m,i)=>'field_'+i+'='+ref(m[1])).join('&');
    if(v.includes('{{'))return v.replace(/\{\{([^}]+)\}\}/g,(_,e)=>ref(e)).split(/(\{\{[^}]+\}\})/g).map(s=>s.startsWith('{{')?s:s?literal(s)+' ':'').join('');
    if(v==='https://slack.com/api/chat.postMessage'&&key==='url')return v;
    if(['url','icon_url','image_url','icon'].includes(key)&&/^https?:/.test(v))return 'https://example.test/'+literal(v,'endpoint');
    if(key==='channel')return 'C'+String(literals.size+1000000);
    if(key==='thread_ts')return '1700000000.000001';
    if(key==='applicationId')return literal(v,'app');
    if(key==='tableName')return literal(v,'table');
    if(key==='rowId')return literal(v,'rec');
    if(key==='searchByField')return field(v);
    if(['max_length','index'].includes(key)&&/^\d+$/.test(v))return '8';
    if(key==='value'&&/^[-+]?\d+(\.\d+)?$/.test(v))return String(Number(literal(v,'number').split('_').at(-1))+10);
    return literal(v);
  }
  const nodes={};
  for(const n of raw){
    let vendor=String(n.selected_api||'').split('@')[0].replace(/^(WebHook|Slack|Airtable|ZapierFormatter)API$/,'$1CLIAPI');
    if(extended)vendor=vendor.replace(/^GoogleSheetsV2API$/,'GoogleSheetsV2CLIAPI');
    const known=appActions[vendor]?.has(n.action)||extended&&vendor==='GoogleSheetsV2CLIAPI'&&['add_row','update_row'].includes(n.action);
    if(!known)vendor='UnsupportedAPI';
    const id=ids.get(String(n.id));
    const params=known?clean(n.params||{}):{unsupported_option:'value_opaque'};
    if(known&&n.params?.searchCriteria)params.unsupported_option='value_opaque';
    nodes[id]={id:Number(id),parent_id:n.parent_id==null?null:Number(ids.get(String(n.parent_id))||9999),selected_api:vendor+(vendor.endsWith('CLIAPI')?'@1.0.0':''),action:known?n.action:'unsupported_action',params};
  }
  return {title:'Sanitized workflow',nodes};
}

export function auditSanitized(workflows, { extended = false } = {}) {
  const allowed=new Set([...structural,...reserved,...publicEnums,...Object.keys(appActions),...Object.values(appActions).flatMap(s=>[...s]),'UnsupportedAPI','unsupported_action','unsupported_option','value_opaque','Sanitized workflow','nodes','title','parent_id','selected_api','params']);
  const errors=[];
  if(extended)for(const k of ['spreadsheet','worksheet','row','drive','timezone','Pick off a Child Key','GoogleSheetsV2CLIAPI','add_row','update_row'])allowed.add(k);
  function walk(v,path='root'){
    if(Array.isArray(v))return v.forEach((x,i)=>walk(x,path+'.'+i));
    if(v&&typeof v==='object')return Object.entries(v).forEach(([k,x])=>{if(!allowed.has(k)&&!/^\d+$/.test(k)&&!/^field_\d+$/.test(k)&&!/^fields__field_\d+$/.test(k)&&!(extended&&/^COL\$[A-Z]{1,3}$/.test(k)))errors.push(path+': unexpected key');walk(x,path+'.'+k);});
    if(typeof v!=='string'||allowed.has(v)||/^-?\d+(\.\d+)?$/.test(v)||/^(?:value|app|table|rec|number|field)_\d+$/.test(v)||v==='SANDBOX_CREDENTIAL'||v==='{{=unsupported_expression}}'||/^C\d{7}$/.test(v)||/^\w+CLIAPI@1\.0\.0$/.test(v))return;
    if(v==='https://slack.com/api/chat.postMessage'||/^https:\/\/example\.test\/endpoint_\d+$/.test(v))return;
    if(/^https:\/\/example\.test\/endpoint_\d+\?/.test(v)){walk(v.slice(v.indexOf('?')+1).replace(/field_\d+=/g,'').replaceAll('&',' '),path+'.url');return;}
    if(v.startsWith('{'))try{walk(JSON.parse(v),path+'.json');return;}catch{}
    const rest=v.replace(/\{\{([^}]+)\}\}/g,(_,e)=>{if(e==='=unsupported_expression')return '';const r=parseReference(e);if(!r||!r.path.every(p=>reserved.has(p)||/^field_\d+$/.test(p)||/^\d+$/.test(p)||extended&&/^COL\$[A-Z]{1,3}$/.test(p)))errors.push(path+': invalid reference');return '';}).replace(/value_\d+/g,'').trim();
    if(rest)errors.push(path+': unexpected literal');
  }
  workflows.forEach(w=>walk(w));
  return {passed:errors.length===0,errors:errors.slice(0,20)};
}
