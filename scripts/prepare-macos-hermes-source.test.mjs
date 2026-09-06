import assert from 'node:assert/strict';
import test from 'node:test';

import { hermesSshUrl, parseHermesSshKey } from './prepare-macos-hermes-source.mjs';

test('fetches the public Hermes source over GitHub SSH', () => {
  assert.equal(hermesSshUrl(), 'git@github.com:NousResearch/hermes-agent.git');
});

test('accepts raw OpenSSH private key directly', () => {
  const dummyKey = '-----BEGIN OPENSSH PRIVATE KEY-----\ndummy-key-data\n-----END OPENSSH PRIVATE KEY-----';
  assert.equal(parseHermesSshKey(dummyKey), dummyKey);
});

test('accepts base64-encoded OpenSSH private key', () => {
  const dummyKey = '-----BEGIN OPENSSH PRIVATE KEY-----\ndummy-key-data\n-----END OPENSSH PRIVATE KEY-----';
  const encoded = Buffer.from(dummyKey, 'utf8').toString('base64');
  assert.equal(parseHermesSshKey(encoded), dummyKey);
});

test('rejects invalid key formats', () => {
  assert.throws(
    () => parseHermesSshKey('invalid key format with spaces!'),
    /HERMES_SOURCE_SSH_KEY must be a raw or base64-encoded OpenSSH private key/u,
  );
});
