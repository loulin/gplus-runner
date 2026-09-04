#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const GIT_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const GIT_NETWORK_COMMANDS = new Set(['ls-remote']);
const RELEASE_BUILD_NUMBER_MAX = 2_147_483_647;
const SOURCE_REF_INVALID_CHARACTERS = new Set([
  '~',
  '^',
  ':',
  '?',
  '*',
  '[',
  '\\',
]);

function fail(message) {
  throw new Error(`[macos-source] ${message}`);
}

function parseArguments(argv) {
  const values = new Map();
  const supported = new Set([
    '--application',
    '--github-output',
    '--profile',
    '--source-dir',
    '--tag',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!supported.has(option) || values.has(option)) {
      fail(`未知或重复参数: ${option || '(empty)'}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      fail(`${option} 缺少值`);
    }
    values.set(option, value);
    index += 1;
  }
  for (const option of ['--application', '--profile', '--source-dir', '--tag']) {
    if (!values.has(option)) fail(`${option} 是必需参数`);
  }
  return {
    application: values.get('--application'),
    githubOutput: values.get('--github-output'),
    profile: values.get('--profile'),
    sourceDir: path.resolve(values.get('--source-dir')),
    tag: values.get('--tag'),
  };
}

function runGit(sourceDir, args, { preserveTrailingWhitespace = false } = {}) {
  const gitArgs = GIT_NETWORK_COMMANDS.has(args[0])
    ? ['-c', 'http.version=HTTP/1.1', ...args]
    : args;
  try {
    const output = execFileSync('git', gitArgs, {
      cwd: sourceDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return preserveTrailingWhitespace ? output : output.trim();
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const detail = stderr ? `: ${stderr}` : '';
    fail(`git ${args.join(' ')} 失败${detail}`);
  }
}

function assertOid(value, label) {
  if (!GIT_OID_PATTERN.test(value)) fail(`${label} 不是有效 Git object ID`);
  return value;
}

function assertSourceRef(value, application) {
  const sourceRef = String(value || '');
  const prefix = application === 'gplus-bot-desktop'
    ? 'origin/'
    : 'refs/heads/';
  const branch = sourceRef.startsWith(prefix)
    ? sourceRef.slice(prefix.length)
    : '';
  const components = branch.split('/');
  const invalidCharacter = [...branch].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x20
      || codePoint === 0x7f
      || SOURCE_REF_INVALID_CHARACTERS.has(character);
  });
  if (
    !branch
    || branch.includes('..')
    || branch.includes('@{')
    || invalidCharacter
    || components.some((component) => (
      !component
      || component.startsWith('.')
      || component.endsWith('.')
      || component.endsWith('.lock')
    ))
  ) {
    fail(`tag source-ref 不符合 ${prefix}* 约束: ${sourceRef}`);
  }
  return sourceRef;
}

function resolveIdentity(application, profile, tag) {
  const pattern = application === 'gplus-bot-desktop'
    ? /^gplus-bot-desktop-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.[1-9]\d*)?)$/u
    : /^libre-reader-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-staging)?)$/u;
  const match = pattern.exec(tag);
  if (!match) fail(`tag 不是 ${application} 的 canonical release tag: ${tag}`);
  const version = match[1];
  const tagProfile = application === 'gplus-bot-desktop'
    ? (version.includes('-rc.') ? 'staging' : 'production')
    : (version.endsWith('-staging') ? 'staging' : 'production');
  if (tagProfile !== profile) {
    fail(`tag profile 与输入不匹配: tag=${tagProfile}, input=${profile}`);
  }
  return { version, profile: tagProfile };
}

function readRemoteTagIdentity(sourceDir, tagRef) {
  const raw = runGit(
    sourceDir,
    ['ls-remote', '--tags', 'origin', tagRef, `${tagRef}^{}`],
    { preserveTrailingWhitespace: true },
  );
  const entries = new Map();
  for (const line of raw.split(/\r?\n/u).filter(Boolean)) {
    const [oid, ref, ...extra] = line.split('\t');
    if (!oid || !ref || extra.length > 0 || entries.has(ref)) {
      fail(`无法解析远端 tag identity: ${line}`);
    }
    entries.set(ref, oid);
  }
  const tagObjectId = entries.get(tagRef);
  const commitId = entries.get(`${tagRef}^{}`);
  if (!tagObjectId || !commitId || entries.size !== 2) {
    fail('远端 release tag 必须同时提供 annotated tag object 和 peeled commit');
  }
  return {
    tagObjectId: assertOid(tagObjectId, '远端 raw tag object ID'),
    commitId: assertOid(commitId, '远端 peeled commit ID'),
  };
}

function assertGplusTagMessage(message, version) {
  const prefix = `release gplus-bot-desktop ${version}\n\nsource-ref: `;
  if (!message.startsWith(prefix) || message.slice(prefix.length).includes('\n')) {
    fail('Gplus Bot Desktop tag message 不是 canonical 格式');
  }
  const sourceRef = message.slice(prefix.length);
  assertSourceRef(sourceRef, 'gplus-bot-desktop');
  if (message !== `${prefix}${sourceRef}`) {
    fail('Gplus Bot Desktop tag message 不是 canonical 格式');
  }
  return sourceRef;
}

function assertLibreTagMessage(message, profile, version) {
  let metadata;
  try {
    metadata = JSON.parse(message);
  } catch (error) {
    fail(`Libre Reader tag metadata 不是有效 JSON: ${error.message}`);
  }
  const expected = {
    schemaVersion: 1,
    profile,
    version,
    sourceRef: metadata?.sourceRef,
  };
  if (
    JSON.stringify(metadata) !== JSON.stringify(expected)
    || metadata.sourceRef !== assertSourceRef(metadata.sourceRef, 'libre-reader')
  ) {
    fail('Libre Reader tag metadata 不是 canonical 格式');
  }
  return metadata.sourceRef;
}

function writeOutputs(filePath, values) {
  if (!filePath) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  appendFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!['gplus-bot-desktop', 'libre-reader'].includes(args.application)) {
    fail(`不支持的 application: ${args.application}`);
  }
  if (!['staging', 'production'].includes(args.profile)) {
    fail(`不支持的 profile: ${args.profile}`);
  }
  const identity = resolveIdentity(args.application, args.profile, args.tag);
  const tagRef = `refs/tags/${args.tag}`;
  const tagObjectId = assertOid(
    runGit(args.sourceDir, ['rev-parse', '--verify', `${tagRef}^{tag}`]),
    '本地 raw tag object ID',
  );
  const commitId = assertOid(
    runGit(args.sourceDir, ['rev-parse', '--verify', `${tagRef}^{commit}`]),
    '本地 peeled commit ID',
  );
  if (runGit(args.sourceDir, ['cat-file', '-t', tagObjectId]) !== 'tag') {
    fail('release tag 必须是 annotated tag，而不是 lightweight tag');
  }
  const remote = readRemoteTagIdentity(args.sourceDir, tagRef);
  if (remote.tagObjectId !== tagObjectId || remote.commitId !== commitId) {
    fail('本地与远端 release tag identity 不一致');
  }
  const headId = assertOid(
    runGit(args.sourceDir, ['rev-parse', 'HEAD']),
    '当前 HEAD',
  );
  if (headId !== commitId) fail('checkout HEAD 不是 release tag 的 peeled commit');

  const packagePath = path.join(
    args.sourceDir,
    args.application === 'gplus-bot-desktop'
      ? 'apps/gplus-bot-desktop/package.json'
      : 'apps/libre-reader/package.json',
  );
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch (error) {
    fail(`无法读取 package.json: ${error.message}`);
  }
  if (packageJson.version !== identity.version) {
    fail(`package version 与 tag 不一致: ${packageJson.version} != ${identity.version}`);
  }
  if (
    typeof packageJson.buildNumber !== 'number'
    || !Number.isSafeInteger(packageJson.buildNumber)
    || packageJson.buildNumber < 1
    || packageJson.buildNumber > RELEASE_BUILD_NUMBER_MAX
  ) {
    fail('package buildNumber 必须是有效的正整数');
  }

  const tagMessage = runGit(
    args.sourceDir,
    ['for-each-ref', '--format=%(contents)', tagRef],
    { preserveTrailingWhitespace: true },
  ).replace(/\r\n/gu, '\n').trimEnd();
  const sourceRef = args.application === 'gplus-bot-desktop'
    ? assertGplusTagMessage(tagMessage, identity.version)
    : assertLibreTagMessage(tagMessage, identity.profile, identity.version);
  writeOutputs(args.githubOutput, {
    build_number: packageJson.buildNumber,
    profile: identity.profile,
    source_ref: sourceRef,
    source_sha: commitId,
    tag_object_id: tagObjectId,
    version: identity.version,
  });
  console.log(
    `[macos-source] verified ${args.application} ${identity.profile}/${identity.version} `
      + `target source ${commitId}`,
  );
}

try {
  main();
} catch (error) {
  console.error(error?.message || error);
  process.exitCode = 1;
}
