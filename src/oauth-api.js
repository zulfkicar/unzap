const cookieValue=req=>String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('un_oauth_browser='))?.slice('un_oauth_browser='.length)||'';
function browserCookie(value,origin) {
  return `un_oauth_browser=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${new URL(origin).protocol==='https:'?'; Secure':''}`;
}
export function oauthApi(manager) {
  return {
    logout(req) { manager.cancelBrowser(cookieValue(req)); },
    async callback(req,res,url,origin) {
      const match=url.pathname.match(/^\/oauth\/callback\/(airtable|slack|google_sheets)$/);
      if(!match||req.method!=='GET')return false;
      try {
        if(['state','code','error'].some(k=>url.searchParams.getAll(k).length>1))throw Error('OAuth callback contains duplicate parameters');
        await manager.finish(match[1],{origin,browser:cookieValue(req),state:url.searchParams.get('state'),code:url.searchParams.get('code'),error:url.searchParams.get('error')});
        res.writeHead(303,{Location:'/#connections','Cache-Control':'no-store'});res.end();
      }catch{
        res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});
        res.end('This OAuth request expired or belongs to another browser. Return to Unzap and start sign-in again.');
      }
      return true;
    },
    async authenticated(req,res,path,origin,readBody,reply) {
      if(path==='/api/oauth/status'&&req.method==='GET'){
        reply(res,200,manager.status(origin));return true;
      }
      if(path==='/api/oauth/result'&&req.method==='GET'){
        reply(res,200,{result:manager.consumeResult(cookieValue(req))});return true;
      }
      const configure=path.match(/^\/api\/oauth\/clients\/(airtable|slack|google_sheets)$/);
      if(configure&&req.method==='POST'){
        const config=manager.configure(configure[1],await readBody(req));
        reply(res,200,{client:config,oauth:manager.status(origin)});return true;
      }
      const begin=path.match(/^\/api\/oauth\/start\/(airtable|slack|google_sheets)$/);
      if(begin&&req.method==='POST'){
        const input=await readBody(req),flow=manager.begin(begin[1],{...input,origin,browser:cookieValue(req)});
        res.setHeader('Set-Cookie',browserCookie(flow.browser,origin));
        reply(res,200,{authorization_url:flow.authorization_url});return true;
      }
      return false;
    },
  };
}
