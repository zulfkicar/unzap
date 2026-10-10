import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const path='.data/expanded-workbench-examples.json';
const report=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{classification:'Inactive local examples from complete sanitized exports. Trained translations and mock API fixture checks. No credentials configured or provider writes.',examples:[]};
const token=execFileSync('wsl.exe',['-e','docker','exec','unzap-app-1','node','-e',"process.stdout.write(require('node:fs').readFileSync('/app/.data/control/login-token','utf8').trim())"],{encoding:'utf8'}).trim();
const origin='http://127.0.0.1:8874';
async function api(path,body,method=body===undefined?'GET':'POST'){
 const r=await fetch(origin+'/api'+path,{method,headers:{Authorization:'Bearer '+token,Origin:origin,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
 const data=await r.json();if(!r.ok)throw Error(data.error||`HTTP ${r.status}`);return data;
}
const verified=JSON.parse(readFileSync('.data/expanded-trained-verification.json','utf8'));
for(const row of verified.cases.filter(c=>c.passed)){
 if(report.examples.some(c=>c.source_id===row.id))continue;
 const selected=verified.selected.find(c=>c.id===row.id);
 const imported=await api('/import',selected.source),id=imported.ids[0];
 let current=await api('/workflows/'+id);
 if(current.version!==1||current.active_version!==null)throw Error('Preserve any existing edited/active source example');
 const definition=structuredClone(row.result.definition);
 definition.name=row.category==='sheets'?'Google Sheets · trained export conversion':'Slack channel join · trained export conversion';
 current=await api('/workflows/'+id,{definition,version:current.version},'PUT');
 await api('/workflows/'+id+'/fixtures',selected.fixture);
 current=await api('/workflows/'+id+'/check',{});
 const passed=current.checks.length>0&&current.checks.every(c=>c.passed===1);
 const result={source_id:row.id,category:row.category,id,url:origin+'/#workflow/'+id,version:current.version,active_version:current.active_version,passed,fixture_cases:current.fixtures.length};
 report.examples.push(result);writeFileSync(path,JSON.stringify(report,null,2));console.log(JSON.stringify(result));
 if(!passed||current.active_version!==null)throw Error('Local example failed verification or was activated');
}
