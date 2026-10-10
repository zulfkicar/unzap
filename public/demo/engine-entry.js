import { importDefinitions, validate, compile, actions } from '../../src/migration.js';
import { createContext } from '../../src/runtime.js';
import { requestFor, normalizeOutput, mockResponse, redact } from '../../src/connectors.js';
import { providers, connectionProvider } from '../../src/accounts.js';
export { importDefinitions, validate, compile, actions, providers, connectionProvider };

// Only compiler-emitted modules run. Source exports are parsed as data, never code.
// The worker has no real transport and never performs destination requests.
export async function replay(definition, input, { found = false, fail = false } = {}) {
  const code = compile(definition);
  const env = Object.fromEntries([
    ...(definition.bindings || []).map(b => [b.name, 'DEMO_ONLY_CREDENTIAL']),
    ...definition.steps.filter(s => s.params.connection).map(s => [s.params.connection, 'DEMO_ONLY_CREDENTIAL']),
  ]);
  const ctx = createContext({ env });
  ctx.action = async (step, params) => {
    const request = requestFor(step, params, env);
    ctx.requests.push({ step_id: step.id, ...redact(request, env) });
    if (fail && ['airtable','airtable_update','slack','sheets_append','sheets_update','http'].includes(step.kind))
      throw Error('Simulated destination failure. The server runtime holds the run for review.');
    const response = step.kind === 'airtable_find'
      ? { records: found ? [{ id: 'rec_demo_existing', fields: { 'Request ID': 'REQ-1042', Summary: 'Existing request' } }] : [] }
      : mockResponse(step, params);
    return normalizeOutput(step, response, params);
  };
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try {
    const result = await (await import(url)).workflow(input, ctx);
    return redact(result, env);
  } finally { URL.revokeObjectURL(url); }
}
