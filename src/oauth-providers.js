// Endpoints and scope vocabulary are fixed server-side. Settings cannot turn
// token exchange into an arbitrary credential-bearing request.
export const oauthProviders = {
  google_sheets: {
    label: 'Google', authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token', identity: 'https://openidconnect.googleapis.com/v1/userinfo',
    scopes: ['openid','email','https://www.googleapis.com/auth/spreadsheets'],
    setup: 'https://console.cloud.google.com/apis/credentials',
    instructions: ['Enable the Google Sheets API and configure the OAuth consent screen.', 'Create an OAuth client of type Web application. Add the exact callback URL shown below.', 'While the app is in Testing, add your Google account as a test user. Testing-mode grants can expire after seven days.'],
    pkce: true, localhost: true, secretRequired: true,
  },
  airtable: {
    label: 'Airtable', authorize: 'https://airtable.com/oauth2/v1/authorize',
    token: 'https://airtable.com/oauth2/v1/token', identity: 'https://api.airtable.com/v0/meta/whoami',
    scopes: ['data.records:read','data.records:write'],
    setup: 'https://airtable.com/create/oauth',
    instructions: ['Create an OAuth integration in Airtable’s Builder Hub.', 'Register the exact callback URL and enable the record read/write scopes shown below.', 'Copy the client ID and, for a confidential integration, the client secret. Public PKCE integrations can leave the secret empty.'],
    pkce: true, localhost: true, secretRequired: false,
  },
  slack: {
    label: 'Slack', authorize: 'https://slack.com/oauth/v2/authorize', token: 'https://slack.com/api/oauth.v2.access',
    scopes: ['chat:write','channels:join'], optionalScopes: ['chat:write.customize'],
    setup: 'https://api.slack.com/apps',
    instructions: ['Create a Slack app and add the bot scopes shown below under OAuth & Permissions.', 'Register this installation’s HTTPS callback URL. Slack does not accept a plain HTTP localhost callback.', 'Enable token rotation to receive expiring access tokens and refresh tokens. Copy the client ID and client secret. Leave PKCE off unless it is enabled for your Slack app.'],
    pkce: false, localhost: false, secretRequired: true,
  },
};
export function callbackUrl(provider, origin) {
  return new URL('/oauth/callback/'+provider, origin).toString();
}
export function validateOAuthClient(provider, value) {
  if (!Object.hasOwn(oauthProviders,provider)) throw Error('This app does not support OAuth');
  const p=oauthProviders[provider];
  if (typeof value.client_id!=='string'||!value.client_id.trim()||value.client_id.length>512) throw Error('Enter a valid OAuth client ID');
  if (typeof value.client_secret!=='string'||value.client_secret.length>4096) throw Error('Invalid client secret');
  const pkce=provider==='slack'?value.pkce===true:p.pkce;
  if ((p.secretRequired && !(provider==='slack'&&pkce)) && !value.client_secret) throw Error('This OAuth client needs a client secret');
  const uri=new URL(value.redirect_uri);
  const local=['localhost','127.0.0.1','[::1]'].includes(uri.hostname);
  if (uri.username||uri.password||uri.hash||uri.search||uri.pathname!=='/oauth/callback/'+provider ||
      (uri.protocol!=='https:' && !(uri.protocol==='http:'&&local&&p.localhost)))
    throw Error(provider==='slack'?'Slack needs an HTTPS callback URL':'Use HTTPS, or an allowed localhost callback, with the exact callback path');
  if (!local && (/^[\d.]+$/.test(uri.hostname)||uri.hostname.includes(':'))) throw Error('Public OAuth callbacks need a domain');
  const scopes=value.scopes||p.scopes;
  if (!Array.isArray(scopes)||!scopes.length||new Set(scopes).size!==scopes.length||scopes.some(s=>![...p.scopes,...(p.optionalScopes||[])].includes(s))) throw Error('Choose only the supported OAuth scopes');
  if(provider==='google_sheets'&&p.scopes.some(s=>!scopes.includes(s)))throw Error('Google sign-in needs the identity, email and Sheets scopes shown here');
  return {client_id:value.client_id.trim(),client_secret:value.client_secret,redirect_uri:uri.toString(),pkce,scopes};
}
export function requiredScopes(kind, params={}) {
  if (kind==='airtable_find') return ['data.records:read'];
  if (['airtable','airtable_update'].includes(kind)) return ['data.records:write'];
  if (kind==='slack_join') return ['channels:join'];
  if (kind==='slack') return ['chat:write',...(params.username||params.icon_url||params.icon_emoji?['chat:write.customize']:[])];
  if (kind.startsWith('sheets_')) return ['https://www.googleapis.com/auth/spreadsheets'];
  return [];
}
