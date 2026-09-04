import assert from 'node:assert/strict';
import test from 'node:test';

import { hermesSshUrl } from './prepare-macos-hermes-source.mjs';

test('fetches the public Hermes source over GitHub SSH', () => {
  assert.equal(hermesSshUrl(), 'git@github.com:NousResearch/hermes-agent.git');
});
