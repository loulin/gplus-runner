const { test } = require('node:test');
const assert = require('node:assert/strict');
const { publisherInvocation, validatePublishInput } = require('./publish-windows-digest-release.cjs');

function fixture(profile = 'staging') {
  const env = { PROFILE: profile, PUBLISH_RELEASE: 'true', DELIVERY_MODE: 'digest', SOURCE_SHA: 'a'.repeat(40), GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', QINIU_ACCESS_KEY: 'test-key', QINIU_SECRET_KEY: 'test-secret', RELEASE_TOKEN: 'test-token' };
  const version = profile === 'production' ? '0.2.6' : '0.2.6-rc.1';
  const handoff = { app: 'gplus-bot-desktop', profile, target: 'win-x64', channel: profile === 'production' ? 'prod' : 'staging', sourceSha: env.SOURCE_SHA, workflowRevision: env.GITHUB_SHA, workflowRunId: 123, workflowRunAttempt: 1, version, buildNumber: 1055, hermesSha: 'c'.repeat(40), sourceProvenance: { appCommit: env.SOURCE_SHA, sourceTag: `gplus-bot-desktop-v${version}`, tagObjectId: 'd'.repeat(40), sourceRef: 'origin/codex/release' } };
  return { env, handoff, workRoot: 'generated', releaseDir: 'signed-release', publishWork: 'publish-work' };
}
for (const profile of ['staging', 'production']) test(`${profile} publishes existing signed bytes to matching environment`, () => {
  const input = fixture(profile);
  const { args, options } = publisherInvocation(input);
  assert.ok(args.includes('--skip-build'));
  assert.equal(args[args.indexOf('--channel') + 1], input.handoff.channel);
  assert.equal(options.env.GPLUS_DESKTOP_UNSIGNED, '0');
  assert.equal(options.env.GPLUS_DESKTOP_RELEASE_DIR, input.releaseDir);
  assert.equal(options.env.GPLUS_DESKTOP_APP_COMMIT, input.handoff.sourceSha);
  assert.equal(options.env.GPLUS_DESKTOP_BUILD_NUMBER, '1055');
  assert.equal(options.env.GPLUS_DESKTOP_RELEASE_API_BASE_URL, profile === 'staging' ? 'https://gplus.staging.imedpower.com' : 'https://ptt.plus');
  assert.equal(options.env.GPLUS_DESKTOP_UPDATE_BASE_URL, profile === 'staging' ? 'https://assets.imedpower.com/apps/gplus-bot-desktop' : 'https://assets.ourdrs.com/apps/gplus-bot-desktop');
});
test('refuses mismatched source, run, channel, tag, and missing publication credentials', () => {
  for (const mutate of [
    f => { f.handoff.sourceSha = 'e'.repeat(40); },
    f => { f.handoff.workflowRunAttempt = 2; },
    f => { f.handoff.channel = 'prod'; },
    f => { f.handoff.sourceProvenance.appCommit = 'e'.repeat(40); },
    f => { f.handoff.sourceProvenance.sourceTag = 'gplus-bot-desktop-v0.2.5'; },
    f => { delete f.env.RELEASE_TOKEN; },
    f => { f.env.PUBLISH_RELEASE = 'false'; },
    f => { f.env.DELIVERY_MODE = 'handoff'; },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => validatePublishInput(input.handoff, input.env));
  }
});
