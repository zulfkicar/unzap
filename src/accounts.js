import { randomBytes, createHash } from 'node:crypto';
export const providers = {
  airtable: { label: 'Airtable', mark: 'A', kinds: ['airtable','airtable_find','airtable_update'], credential: 'Personal access token', placeholder: 'pat…',
    help: ['Open Airtable’s developer hub and create a personal access token.', 'For lookup steps, add data.records:read. For create/update steps, add data.records:write.', 'Select only the bases this account should access, then copy the token here.'],
    url: 'https://support.airtable.com/articles/9934989703-creating-personal-access-tokens', note: 'One token can access several selected bases. Store it once and reuse this account across workflows.' },
  slack: { label: 'Slack', mark: '#', kinds: ['slack','slack_join'], credential: 'Bot user OAuth token', placeholder: 'xoxb-…',
    help: ['Create or open your Slack app, then open OAuth & Permissions.', 'Add chat:write. Add channels:join if workflows join public channels, or chat:write.customize for custom names/icons.', 'Install the app in your workspace and copy its Bot User OAuth Token. Invite the bot to private channels yourself.'],
    url: 'https://docs.slack.dev/authentication/tokens/', note: 'Use a separate account for each Slack workspace or bot identity.' },
  google_sheets: { label: 'Google Sheets', mark: 'G', kinds: ['sheets_append','sheets_update','sheets_resolve'], credential: 'OAuth access token', placeholder: 'Google OAuth access token',
    help: ['Use a Google OAuth access token authorized for the Sheets API.', 'The account needs spreadsheet access and the spreadsheets scope, or an applicable drive.file grant.', 'Manually supplied access tokens need manual replacement when they expire. Use Google sign-in for automatic token renewal.'],
    url: 'https://developers.google.com/workspace/sheets/api/scopes', note: 'A Google API key alone cannot authorize private spreadsheet writes.' },
  custom: { label: 'Custom API', mark: '{}', kinds: [], credential: 'Secret value', placeholder: 'API token or secret',
    help: ['Save the credential under a name you recognize.', 'Use the generated environment binding in your HTTP authentication mapping.', 'Use one account per destination or credential identity.'],
    note: 'The advanced binding is available for HTTP headers and other explicit environment mappings.' },
};
export function connectionProvider(kind) {
  return Object.keys(providers).find(id => providers[id].kinds.includes(kind)) || null;
}
export function inferProvider(binding) {
  if (/^AIRTABLE(?:_|$)/.test(binding)) return 'airtable';
  if (/^SLACK(?:_|$)/.test(binding)) return 'slack';
  if (/^GOOGLE_SHEETS(?:_|$)/.test(binding)) return 'google_sheets';
  return 'custom';
}
export function accountBinding(provider, label) {
  const slug = String(label).toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,45) || 'ACCOUNT';
  return provider.toUpperCase()+'_'+slug+'_'+randomBytes(3).toString('hex').toUpperCase();
}
export function importedAccountBinding(provider, authenticationId) {
  return provider.toUpperCase()+'_SOURCE_'+createHash('sha256').update(JSON.stringify([provider,String(authenticationId)])).digest('hex').slice(0,12).toUpperCase();
}
export function assignAccount(definition, stepIds, account) {
  if (!Array.isArray(stepIds) || !stepIds.length || new Set(stepIds).size !== stepIds.length) throw Error('Choose one or more distinct workflow steps');
  const d=structuredClone(definition);
  for (const id of stepIds) {
    const step=d.steps.find(s=>s.id===id);
    if (!step || !connectionProvider(step.kind)) throw Error('Choose a step with an account-based integration');
    if (connectionProvider(step.kind)!==account.provider) throw Error('This account belongs to a different app');
    step.params.connection=account.binding;
  }
  return d;
}
