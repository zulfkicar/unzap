import { importDefinitions, validate, compile, actions, providers, connectionProvider, replay } from './engine.js';
self.onmessage = async ({ data }) => {
  const { id, operation, source, definition, input, options } = data;
  try {
    let result;
    if (operation === 'import') {
      const data = typeof source === 'string' ? JSON.parse(source) : source;
      const list = Array.isArray(data) ? data : data?.zaps || (data?.nodes ? [data] : []);
      if (list.length > 200) throw Error('The browser demo supports up to 200 workflows. Use the self-hosted application for full backups.');
      const definitions = importDefinitions(data);
      result = { definitions, plans: definitions.map(validate), actions, providers };
    } else if (operation === 'assess') {
      const plan = validate(definition);
      result = { plan, code: plan.ready ? compile(definition) : null,
        accounts: [...new Set(definition.steps.map(s => connectionProvider(s.kind)).filter(Boolean))] };
    } else if (operation === 'replay') result = await replay(definition, input, options);
    else throw Error('Unknown demo operation');
    self.postMessage({ id, result });
  } catch (error) { self.postMessage({ id, error: error.message }); }
};
