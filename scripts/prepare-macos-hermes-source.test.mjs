import assert from 'node:assert/strict';
import test from 'node:test';

import { validateArchiveListing } from './prepare-macos-hermes-source.mjs';

test('accepts a single-root GitHub source archive listing', () => {
  assert.equal(
    validateArchiveListing([
      'hermes-agent-f80f453ae0679347e38abc917c7f94f717bf96c5/',
      'hermes-agent-f80f453ae0679347e38abc917c7f94f717bf96c5/package.json',
      'hermes-agent-f80f453ae0679347e38abc917c7f94f717bf96c5/apps/desktop/',
    ].join('\n')),
    'hermes-agent-f80f453ae0679347e38abc917c7f94f717bf96c5',
  );
});
test('rejects archive path traversal and multiple roots', () => {
  assert.throws(
    () => validateArchiveListing('hermes-agent-root/\n../outside'),
    /unsafe path/u,
  );
  assert.throws(
    () => validateArchiveListing('hermes-agent-root/\nother-root/file'),
    /multiple top-level directories/u,
  );
});

test('rejects absolute and backslash archive paths', () => {
  assert.throws(
    () => validateArchiveListing('/absolute/file'),
    /unsafe path/u,
  );
  assert.throws(
    () => validateArchiveListing('hermes-agent-root\\file'),
    /unsafe path/u,
  );
});
