import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as server from '../src/migration.js';
import * as browser from '../public/demo/engine.js';

for (const fixture of ['find-or-create-paths.json', 'webhook-filter-http.json', 'maintenance-alert.json']) {
  test(`browser compiler preserves production import and compilation contracts: ${fixture}`, () => {
    const source = JSON.parse(readFileSync(new URL('../fixtures/' + fixture, import.meta.url)));
    const expected = server.importDefinitions(source), actual = browser.importDefinitions(source);
    assert.deepEqual(actual, expected, 'Includes SHA-256 fingerprints, redacted bindings and reference rewriting');
    for (const [i, definition] of actual.entries()) {
      assert.deepEqual(browser.validate(definition), server.validate(expected[i]));
      for (const step of definition.steps) step.review_required = false;
      const plan = browser.validate(definition);
      if (plan.ready) assert.equal(browser.compile(definition), server.compile(definition));
      else assert.throws(() => browser.compile(definition), /Resolve migration issues/);
    }
  });
}
test('portfolio sample reuses one imported account across both mutually exclusive branches', () => {
  const source = JSON.parse(readFileSync(new URL('../public/demo/sample.json', import.meta.url)));
  const definition = browser.importDefinitions(source)[0];
  assert.deepEqual(definition, server.importDefinitions(source)[0]);
  const bindings = definition.steps.filter(s => s.params.connection).map(s => s.params.connection);
  assert.equal(bindings.length, 3);
  assert.equal(new Set(bindings).size, 1);
  assert.equal(browser.validate(definition).ready, false, 'Mapping review is required');
  definition.steps.forEach(s => s.review_required = false);
  assert.equal(browser.validate(definition).ready, true);
  assert.equal(browser.compile(definition), server.compile(definition));
});
test('an unknown source action cannot compile after mapping review', () => {
  const definition = browser.importDefinitions({title:'Unsupported',nodes:{1:{id:1,parent_id:null,selected_api:'UnknownApp',action:'launch',params:{}}}})[0];
  definition.steps.forEach(s => s.review_required = false);
  assert.equal(browser.validate(definition).ready, false);
  assert.throws(() => browser.compile(definition), /Resolve migration issues/);
});
