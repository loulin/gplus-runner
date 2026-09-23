const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  expectedPublishState,
  publisherInvocation,
  validatePublishInput,
  validatePublishResult,
} = require('./publish-windows-digest-release.cjs');

function fixture(profile = 'staging') {
  const env = { PROFILE: profile, PUBLISH_RELEASE: 'true', DELIVERY_MODE: 'digest', SOURCE_SHA: 'a'.repeat(40), GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', QINIU_ACCESS_KEY: 'test-key', QINIU_SECRET_KEY: 'test-secret', RELEASE_TOKEN: 'test-token' };
  const version = profile === 'production' ? '0.2.6' : '0.2.6-rc.1';
  const handoff = { app: 'gplus-bot-desktop', profile, target: 'win-x64', channel: profile === 'production' ? 'prod' : 'staging', sourceSha: env.SOURCE_SHA, workflowRevision: env.GITHUB_SHA, workflowRunId: 123, workflowRunAttempt: 1, version, buildNumber: 1055, hermesSha: 'c'.repeat(40), sourceProvenance: { appCommit: env.SOURCE_SHA, sourceTag: `gplus-bot-desktop-v${version}`, tagObjectId: 'd'.repeat(40), sourceRef: 'origin/codex/release' } };
  return { env, handoff, workRoot: 'generated', releaseDir: 'signed-release', publishWork: 'publish-work', signerSubjectName: '上海和杰健康咨询有限公司' };
}
function publishResult(input, overrides = {}) {
  const expected = expectedPublishState(input.env);
  return {
    channel: input.handoff.channel,
    target: input.handoff.target,
    version: input.handoff.version,
    buildNumber: input.handoff.buildNumber,
    dryRun: false,
    releaseApi: 'on',
    release: { softwareId: 6, code: input.handoff.buildNumber, status: expected.releaseStatus },
    manifest: { name: 'latest.yml', status: expected.manifestStatus },
    publishMode: expected.publishMode,
    ...overrides,
  };
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
  assert.equal(options.env.WIN_CSC_SUBJECT_NAME, input.signerSubjectName);
  assert.equal(options.env.GPLUS_DESKTOP_RELEASE_API_BASE_URL, profile === 'staging' ? 'https://gplus.staging.imedpower.com' : 'https://ptt.plus');
  assert.equal(options.env.GPLUS_DESKTOP_UPDATE_BASE_URL, profile === 'staging' ? 'https://assets.imedpower.com/apps/gplus-bot-desktop' : 'https://assets.ourdrs.com/apps/gplus-bot-desktop');
});
test('the default operation registers a draft candidate without moving the channel pointer', () => {
  const input = fixture();
  const { args } = publisherInvocation(input);
  // The application publisher already defaults to a draft candidate, so no promotion flag is passed.
  assert.ok(!args.includes('--promote'));
  assert.deepEqual(expectedPublishState(input.env), { manifestStatus: 'candidate', publishMode: 'candidate', releaseStatus: 'draft' });
  assert.deepEqual(validatePublishResult(input.handoff, publishResult(input), input.env), { channel: 'staging', baseUrl: 'https://assets.imedpower.com/apps/gplus-bot-desktop', apiUrl: 'https://gplus.staging.imedpower.com' });
});
test('promote=true asks the publisher to go live', () => {
  const input = fixture();
  input.env.PROMOTE_RELEASE = 'true';
  const { args } = publisherInvocation(input);
  assert.ok(args.includes('--promote'));
  assert.deepEqual(expectedPublishState(input.env), { manifestStatus: 'published', publishMode: 'promoted', releaseStatus: 'published' });
  assert.deepEqual(validatePublishResult(input.handoff, publishResult(input), input.env), { channel: 'staging', baseUrl: 'https://assets.imedpower.com/apps/gplus-bot-desktop', apiUrl: 'https://gplus.staging.imedpower.com' });
});
test('a candidate operation is not accepted as a promoted release and vice versa', () => {
  const candidate = fixture();
  const promoted = fixture();
  promoted.env.PROMOTE_RELEASE = 'true';
  // Candidate run that unexpectedly went live.
  assert.throws(() => validatePublishResult(candidate.handoff, publishResult(candidate, { release: { softwareId: 6, code: 1055, status: 'published' } }), candidate.env), /release status must be draft/);
  assert.throws(() => validatePublishResult(candidate.handoff, publishResult(candidate, { manifest: { name: 'latest.yml', status: 'published' } }), candidate.env), /manifest status must be candidate/);
  // Promoted run that stopped at the draft candidate.
  assert.throws(() => validatePublishResult(promoted.handoff, publishResult(promoted, { release: { softwareId: 6, code: 1055, status: 'draft' } }), promoted.env), /release status must be published/);
  assert.throws(() => validatePublishResult(promoted.handoff, publishResult(promoted, { manifest: { name: 'latest.yml', status: 'candidate' } }), promoted.env), /manifest status must be published/);
  // Mismatched build number or dry-run are still rejected in both modes.
  assert.throws(() => validatePublishResult(candidate.handoff, publishResult(candidate, { buildNumber: 1054 }), candidate.env), /did not confirm the requested release/);
  assert.throws(() => validatePublishResult(promoted.handoff, publishResult(promoted, { dryRun: true }), promoted.env), /did not confirm the requested release/);
});
test('requires the digest signer Subject CN before invoking the publisher', () => {
  const input = fixture('production');
  delete input.signerSubjectName;
  assert.throws(() => publisherInvocation(input), /signer Subject CN/);
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
