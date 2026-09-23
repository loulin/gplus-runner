const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const profiles = Object.freeze({
  staging: { channel: 'staging', baseUrl: 'https://assets.imedpower.com/apps/gplus-bot-desktop', apiUrl: 'https://gplus.staging.imedpower.com' },
  production: { channel: 'prod', baseUrl: 'https://assets.ourdrs.com/apps/gplus-bot-desktop', apiUrl: 'https://ptt.plus' },
});
function ensure(ok, message) { if (!ok) throw new Error(message); }
function requiredSignerSubjectName(value) {
  const subjectName = String(value || '').trim();
  ensure(subjectName, 'Digest publish requires the signer Subject CN');
  return subjectName;
}
function releaseProfile(profile) {
  ensure(Object.hasOwn(profiles, profile), 'Unsupported release profile');
  return profiles[profile];
}
// The application publisher registers a draft candidate by default and only goes live when it is
// asked to promote. The runner keeps that split explicit: `publish` uploads and registers,
// `promote` switches the release API record and the canonical feed pointer.
function promoteRequested(env) {
  return env.PROMOTE_RELEASE === 'true';
}
function expectedPublishState(env) {
  return promoteRequested(env)
    ? { manifestStatus: 'published', publishMode: 'promoted', releaseStatus: 'published' }
    : { manifestStatus: 'candidate', publishMode: 'candidate', releaseStatus: 'draft' };
}
function validatePublishInput(handoff, env) {
  const profile = releaseProfile(env.PROFILE);
  ensure(env.PUBLISH_RELEASE === 'true' && env.DELIVERY_MODE === 'digest', 'Publishing requires explicit digest publish operation');
  ensure(handoff.app === 'gplus-bot-desktop' && handoff.target === 'win-x64' && handoff.profile === env.PROFILE && handoff.channel === profile.channel, 'Publish handoff identity mismatch');
  ensure(handoff.sourceSha === env.SOURCE_SHA && /^[a-f0-9]{40}$/.test(handoff.sourceSha), 'Publish source SHA mismatch');
  ensure(handoff.workflowRunId === Number(env.GITHUB_RUN_ID) && handoff.workflowRunAttempt === Number(env.GITHUB_RUN_ATTEMPT) && handoff.workflowRevision === env.GITHUB_SHA, 'Publish run identity mismatch');
  const provenance = handoff.sourceProvenance;
  ensure(provenance && provenance.appCommit === handoff.sourceSha && provenance.sourceTag === `gplus-bot-desktop-v${handoff.version}` && /^[a-f0-9]{40}$/.test(provenance.tagObjectId) && provenance.tagObjectId !== provenance.appCommit && /^origin\/.+/.test(provenance.sourceRef), 'Publish requires matching canonical annotated tag provenance');
  ensure(Number.isSafeInteger(handoff.buildNumber) && handoff.buildNumber > 0, 'Publish requires a positive build number');
  ensure(env.QINIU_ACCESS_KEY && env.QINIU_SECRET_KEY && env.RELEASE_TOKEN, 'Qiniu and Release API credentials are required');
  return profile;
}
function validatePublishResult(handoff, publishResult, env) {
  const profile = releaseProfile(env.PROFILE);
  const expected = expectedPublishState(env);
  ensure(publishResult.dryRun === false, 'Publisher did not confirm the requested release');
  ensure(publishResult.channel === handoff.channel && publishResult.target === handoff.target && publishResult.version === handoff.version && publishResult.buildNumber === handoff.buildNumber, 'Publisher did not confirm the requested release');
  ensure(publishResult.release?.code === handoff.buildNumber, 'Publisher did not confirm the requested release');
  ensure(publishResult.release?.status === expected.releaseStatus, `Publisher release status must be ${expected.releaseStatus} for this operation`);
  ensure(publishResult.manifest?.status === expected.manifestStatus, `Publisher manifest status must be ${expected.manifestStatus} for this operation`);
  ensure(publishResult.publishMode === expected.publishMode, `Publisher mode must be ${expected.publishMode} for this operation`);
  ensure(publishResult.releaseApi === 'on', 'Publisher must run with the release API enabled');
  return profile;
}
function publisherInvocation({ handoff, workRoot, releaseDir, publishWork, signerSubjectName, env }) {
  const profile = validatePublishInput(handoff, env);
  const provenance = handoff.sourceProvenance;
  const resolvedSignerSubjectName = requiredSignerSubjectName(signerSubjectName);
  const args = [path.join(workRoot, 'apps/gplus-bot-desktop/scripts/release-gplus-desktop-update.mjs'), '--target', handoff.target, '--channel', profile.channel, '--version', handoff.version, '--package-json', path.join(workRoot, 'apps/gplus-bot-desktop/package.json'), '--skip-build', '--base-url', profile.baseUrl];
  // Promotion is opt-in: without the flag the publisher stops at the draft candidate.
  if (promoteRequested(env)) args.push('--promote');
  return {
    args,
    options: {
      cwd: workRoot,
      stdio: 'inherit',
      env: {
        ...env,
        GPLUS_DESKTOP_RELEASE_TARGET: handoff.target,
        GPLUS_DESKTOP_UPDATE_CHANNEL: profile.channel,
        GPLUS_DESKTOP_UPDATE_BASE_URL: profile.baseUrl,
        GPLUS_DESKTOP_RELEASE_API_BASE_URL: profile.apiUrl,
        GPLUS_DESKTOP_BUILD_NUMBER: String(handoff.buildNumber),
        GPLUS_DESKTOP_SOURCE_TAG: provenance.sourceTag,
        GPLUS_DESKTOP_TAG_OBJECT_ID: provenance.tagObjectId,
        GPLUS_DESKTOP_APP_COMMIT: provenance.appCommit,
        GPLUS_DESKTOP_SOURCE_REF: provenance.sourceRef,
        GPLUS_DESKTOP_HERMES_COMMIT: handoff.hermesSha,
        GPLUS_DESKTOP_SOURCE_REPO_ROOT: workRoot,
        GPLUS_DESKTOP_RELEASE_DIR: releaseDir,
        GPLUS_DESKTOP_PUBLISH_WORK_DIR: publishWork,
        GPLUS_DESKTOP_UNSIGNED: '0',
        DESKTOP_WIN_SKIP_SIGN_AND_EDIT: '0',
        WIN_CSC_SUBJECT_NAME: resolvedSignerSubjectName,
      },
    },
  };
}
async function publishSignedRelease(input) {
  const invocation = publisherInvocation(input);
  const { handoff, workRoot, releaseDir, publishWork } = input;
  const app = path.join(workRoot, 'apps/gplus-bot-desktop');
  const { createGplusDesktopReleaseIdentity } = await import(pathToFileURL(path.join(app, 'src/updates/gplus-desktop-release-git.mjs')).href);
  createGplusDesktopReleaseIdentity({ channel: handoff.channel, version: handoff.version });
  const { inspectGplusDesktopPackagedRuntime } = await import(pathToFileURL(path.join(app, 'src/updates/gplus-desktop-packaged-runtime.mjs')).href);
  const runtimeEvidence = inspectGplusDesktopPackagedRuntime({ target: handoff.target, targetRoot: workRoot, releaseDir, version: handoff.version, buildNumber: handoff.buildNumber });
  const bash = spawnSync('bash', ['--version'], { stdio: 'ignore' });
  ensure(!bash.error && bash.status === 0, 'Publishing requires Git Bash');
  const result = spawnSync(process.execPath, invocation.args, invocation.options);
  if (result.error) throw result.error;
  ensure(result.status === 0, `Gplus Desktop publisher failed: exit ${result.status}`);
  const publishResult = JSON.parse(fs.readFileSync(path.join(publishWork, 'publish-result.json'), 'utf8'));
  validatePublishResult(handoff, publishResult, input.env);
  return { runtimeEvidence, ...publishResult };
}
module.exports = { releaseProfile, promoteRequested, expectedPublishState, validatePublishInput, validatePublishResult, publisherInvocation, publishSignedRelease };
