import { parseReference, resolve } from '../src/runtime.js';
import { sourceAction } from '../finetune/export-oracle.js';

// Independent request fixtures from source fields. This intentionally supports
// only short, complete webhook -> Sheets/Slack chains, without filters or branches.
// Branch verification uses the frozen source-control oracle in the other suite.
const refs = (v, rows = []) => {
  if (typeof v === 'string') for (const m of v.matchAll(/\{\{([^}]+)\}\}/g)) {
    const r = parseReference(m[1]); if (r) rows.push(r);
  }
  else if (Array.isArray(v)) v.forEach(x => refs(x,rows));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => refs(x,rows));
  return rows;
};
function assign(object,path,value) {
  let current = object;
  for (const key of path.slice(0,-1)) { current[key] ||= {}; current = current[key]; }
  current[path.at(-1)] = value;
}
function column(column) {
  return [...column].reduce((n,c) => 26*n + c.charCodeAt(0)-64,0)-1;
}
export function expandedFixture(source) {
  const nodes = Object.values(source.nodes), root = nodes.find(n => n.parent_id == null);
  if (!root || nodes.some(n => n !== root && !/^Slack|^GoogleSheetsV2/.test(n.selected_api))) throw Error('Fixture scope is a complete webhook/Sheets/Slack chain');
  const payload = {};
  for (const r of nodes.flatMap(n => refs(n.params))) if (r.step_id === String(root.id)) assign(payload,r.path,'Sandbox '+r.path.join('_'));
  for (const n of nodes) for (const key of ['channel','thread_ts','spreadsheet','worksheet','row']) {
    const r = typeof n.params[key] === 'string' && n.params[key].match(/^\{\{([^}]+)\}\}$/);
    const ref = r && parseReference(r[1]);
    if (ref?.step_id === String(root.id)) assign(payload,ref.path,{channel:'C1000000',thread_ts:'1700000000.000001',spreadsheet:'spreadsheet_demo',worksheet:0,row:12}[key]);
  }
  const child = root.params.key || root.params['Pick off a Child Key'];
  const input = child ? { [child]: payload } : payload;
  const outputs = { [root.id]: payload }, responses = {}, requests = [];
  const add = (step_id,url,method,body) => requests.push({ step_id, url, method, body: body === undefined ? null : JSON.stringify(body) });
  for (const n of nodes.filter(n => n !== root)) {
    const id = String(n.id), p = resolve(n.params,outputs);
    if (n.selected_api.startsWith('GoogleSheetsV2')) {
      const entries = Object.entries(p).filter(([k]) => /^COL\$[A-Z]+$/.test(k)).map(([k,v]) => [k.slice(4),v]).sort(([a],[b]) => column(a)-column(b));
      const title = "Ops'2026", a1 = "'Ops''2026'", base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(p.spreadsheet)}`;
      add(id+'__sheet',base+'?fields=sheets.properties(sheetId,title)','GET');
      responses[id+'__sheet'] = { sheets: [{ properties: { sheetId: Number(p.worksheet),title } }] };
      let row = 12;
      if (n.action === 'add_row') {
        const values = Array(column(entries.at(-1)[0])+1).fill(null);
        entries.forEach(([c,v]) => values[column(c)] = v);
        const range = a1+'!A:'+entries.at(-1)[0];
        const query = 'valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS&includeValuesInResponse=true&responseValueRenderOption=FORMATTED_VALUE';
        add(id,base+'/values/'+encodeURIComponent(range)+':append?'+query,'POST',{range,majorDimension:'ROWS',values:[values]});
        responses[id] = { spreadsheetId:p.spreadsheet,updates:{updatedRange:a1+'!A12:'+entries.at(-1)[0]+'12',updatedRows:1,updatedData:{values:[values.map(v=>v??'')]}} };
      } else if (n.action === 'update_row') {
        row = Number(p.row);
        add(id,base+'/values:batchUpdate','POST',{valueInputOption:'USER_ENTERED',includeValuesInResponse:true,responseValueRenderOption:'FORMATTED_VALUE',data:entries.map(([c,v])=>({range:a1+'!'+c+row,majorDimension:'ROWS',values:[[v]]}))});
        responses[id]={spreadsheetId:p.spreadsheet,responses:entries.map(([c,v])=>({updatedRange:a1+'!'+c+row,updatedRows:1,updatedData:{values:[[v]]}}))};
      } else throw Error('Unsupported Sheets source action');
      outputs[id]={id:String(row),row,...Object.fromEntries(entries.map(([c,v])=>['COL$'+c,v??'']))};
    } else {
      if ([true,'true','yes'].includes(p.add_app_to_channel)) {
        add(id+'__join','https://slack.com/api/conversations.join','POST',{channel:p.channel});
        responses[id+'__join']={ok:true,channel:{id:p.channel,is_member:true}};
      }
      const message = sourceAction(n,outputs);
      const body = { channel:message.channel,text:message.text,
        ...Object.fromEntries(['thread_ts','blocks','attachments','username','icon_url','icon_emoji','unfurl_links','unfurl_media','reply_broadcast','link_names'].filter(k=>message[k]!==undefined).map(k=>[k,message[k]])),
        ...(message.unfurl!==undefined?{unfurl_links:message.unfurl,unfurl_media:message.unfurl}:{}) };
      add(id,'https://slack.com/api/chat.postMessage','POST',body);
      const messageReceipt={text:p.text};
      responses[id]={ok:true,channel:p.channel,ts:'1700000000.000001',message:messageReceipt};
      outputs[id]={channel:p.channel,ts:'1700000000.000001',message:messageReceipt};
    }
  }
  return { name:'Complete sanitized export · exact requests',input,responses,expected_status:'succeeded',expected_requests:requests,expected_outputs:outputs };
}
