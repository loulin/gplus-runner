#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERMES_PATH = 'apps/gplus-bot-desktop/vendor/hermes-agent';
const HERMES_URL = 'https://github.com/NousResearch/hermes-agent.git';
const HERMES_REPOSITORY = 'NousResearch/hermes-agent';
const HERMES_TAG_PATTERN = /^v\d{4}\.\d+\.\d+(?:\.\d+)?$/u;
const GIT_OID_PATTERN = /^[0-9a-f]{40}$/u;
const FETCH_ATTEMPTS = 5;
const GIT_FETCH_TIMEOUT_MS = 120_000;

function fail(message) {
  throw new Error(`[macos-hermes] ${message}`);
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--source-dir' || !argv[1] || argv[1].startsWith('--')) {
    fail('usage: prepare-macos-hermes-source.mjs --source-dir <gplus-source-root>');
  }
  return { sourceDir: path.resolve(argv[1]) };
}

function run(command, args, { cwd, auth = false, timeoutMs } = {}) {
  const commandArgs = auth
    ? ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${authHeader()}`, ...args]
    : args;
  try {
    return execFileSync(command, commandArgs, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const detail = stderr ? `: ${stderr}` : '';
    fail(`${command} ${args.join(' ')} failed${detail}`);
  }
}

function output(command, args, options) {
  return String(run(command, args, options)).trim();
}

function githubToken() {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) fail('GITHUB_TOKEN is required to fetch the public Hermes source');
  return token;
}

function authHeader() {
  return Buffer.from(`x-access-token:${githubToken()}`, 'utf8').toString('base64');
}

function assertOid(value, label) {
  if (!GIT_OID_PATTERN.test(value)) fail(`${label} is not a 40-character Git SHA`);
  return value;
}

function loadHermesLock(sourceDir) {
  const lockPath = path.join(sourceDir, 'apps/gplus-bot-desktop/vendor/hermes-source-lock.json');
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch (error) {
    fail(`unable to read Hermes source lock: ${error.message}`);
  }
  const upstream = lock?.upstream;
  if (
    upstream?.name !== HERMES_REPOSITORY
    || upstream.url !== HERMES_URL
    || !GIT_OID_PATTERN.test(upstream.commit || '')
    || !GIT_OID_PATTERN.test(upstream.tagObject || '')
    || !HERMES_TAG_PATTERN.test(upstream.tag || '')
  ) {
    fail('Hermes source lock has an invalid upstream identity');
  }
  if (lock.vendorPath !== HERMES_PATH || lock.mayVendorSourceSnapshot !== false) {
    fail('Hermes source lock does not require the verified submodule path');
  }
  return { upstream };
}

function readExpectedIdentity(sourceDir, upstream) {
  const declaredUrl = output('git', [
    'config', '--file', '.gitmodules', '--get', `submodule.${HERMES_PATH}.url`,
  ], { cwd: sourceDir });
  if (declaredUrl !== HERMES_URL) {
    fail(`.gitmodules Hermes URL must remain ${HERMES_URL}; got ${declaredUrl || 'missing'}`);
  }
  const gitlinkCommit = assertOid(
    output('git', ['rev-parse', `HEAD:${HERMES_PATH}`], { cwd: sourceDir }),
    'Gplus Hermes gitlink',
  );
  if (gitlinkCommit !== upstream.commit) {
    fail(`Gplus Hermes gitlink does not match the source lock: ${gitlinkCommit} != ${upstream.commit}`);
  }
  return {
    commit: upstream.commit,
    tag: upstream.tag,
    tagObject: upstream.tagObject,
  };
}

export function validateArchiveListing(listing) {
  const entries = String(listing)
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) fail('Hermes source archive is empty');

  let root = '';
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.includes('\\')) {
      fail(`Hermes source archive contains an unsafe path: ${entry}`);
    }
    const parts = entry.replace(/\/$/u, '').split('/');
    if (parts.some((part) => !part || part === '.' || part === '..')) {
      fail(`Hermes source archive contains an unsafe path: ${entry}`);
    }
    if (!root) root = parts[0];
    if (parts[0] !== root) {
      fail('Hermes source archive contains multiple top-level directories');
    }
  }
  return root;
}

function downloadHermesArchive(tempRoot, commit) {
  const archivePath = path.join(tempRoot, 'hermes-source.tar.gz');
  const token = githubToken();
  const curlConfigPath = path.join(tempRoot, 'curl-config');
  writeFileSync(curlConfigPath, [
    'silent',
    'show-error',
    'location',
    'fail',
    'retry = 4',
    'retry-all-errors',
    'retry-delay = 15',
    'connect-timeout = 30',
    'max-time = 120',
    'header = "Accept: application/vnd.github+json"',
    `header = "Authorization: Bearer ${token}"`,
    'header = "User-Agent: gplus-runner-macos-release"',
    `output = "${archivePath}"`,
    `url = "https://api.github.com/repos/${HERMES_REPOSITORY}/tarball/${commit}"`,
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });
  try {
    run('curl', ['--config', curlConfigPath]);
  } finally {
    rmSync(curlConfigPath, { force: true });
  }
  return archivePath;
}

function fetchWithRetry(repoPath, args, label) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      run('git', args, {
        cwd: repoPath,
        auth: true,
        timeoutMs: GIT_FETCH_TIMEOUT_MS,
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === FETCH_ATTEMPTS) break;
      const delay = attempt * 15;
      console.warn(`[macos-hermes] ${label} failed; retrying in ${delay}s (${attempt}/${FETCH_ATTEMPTS})`);
      run('sleep', [String(delay)]);
    }
  }
  throw lastError;
}

function prepareCheckout({ sourceDir, archivePath, identity }) {
  const hermesCheckout = path.join(sourceDir, HERMES_PATH);
  rmSync(hermesCheckout, { recursive: true, force: true });
  mkdirSync(hermesCheckout, { recursive: true, mode: 0o755 });
  run('tar', [
    '-xzf', archivePath,
    '--strip-components=1',
    '--no-same-owner',
    '-C', hermesCheckout,
  ]);
  run('git', ['init', '--quiet', hermesCheckout]);
  run('git', ['-C', hermesCheckout, 'config', 'core.autocrlf', 'false']);
  run('git', ['-C', hermesCheckout, 'config', 'core.symlinks', 'true']);
  run('git', ['-C', hermesCheckout, 'remote', 'add', 'origin', HERMES_URL]);

  fetchWithRetry(
    hermesCheckout,
    ['fetch', '--no-tags', '--depth', '1', '--filter=blob:none', 'origin', identity.commit],
    'Hermes commit fetch',
  );
  fetchWithRetry(
    hermesCheckout,
    [
      'fetch', '--depth', '1', '--filter=blob:none', 'origin',
      `refs/tags/${identity.tag}:refs/tags/${identity.tag}`,
    ],
    'Hermes annotated tag fetch',
  );

  const actualTagObject = assertOid(
    output('git', ['-C', hermesCheckout, 'rev-parse', `refs/tags/${identity.tag}^{tag}`]),
    'Hermes tag object',
  );
  const actualTagCommit = assertOid(
    output('git', ['-C', hermesCheckout, 'rev-parse', `refs/tags/${identity.tag}^{commit}`]),
    'Hermes tag commit',
  );
  if (actualTagObject !== identity.tagObject || actualTagCommit !== identity.commit) {
    fail(`Hermes tag identity mismatch: expected ${identity.tagObject}/${identity.commit}, got ${actualTagObject}/${actualTagCommit}`);
  }

  run('git', ['-C', hermesCheckout, 'add', '--force', '--all']);
  const actualTree = output('git', ['-C', hermesCheckout, 'write-tree']);
  const expectedTree = output('git', [
    '-C', hermesCheckout, 'show', '-s', '--format=%T', identity.commit,
  ]);
  if (actualTree !== expectedTree) {
    fail(`Hermes source archive tree mismatch: expected ${expectedTree}, got ${actualTree}`);
  }

  run('git', ['-C', hermesCheckout, 'update-ref', '--no-deref', 'HEAD', identity.commit]);
  if (output('git', ['-C', hermesCheckout, 'rev-parse', 'HEAD']) !== identity.commit) {
    fail('Hermes checkout HEAD does not match the locked commit');
  }
  if (output('git', ['-C', hermesCheckout, 'status', '--porcelain', '--untracked-files=all'])) {
    fail('Hermes checkout is dirty after archive verification');
  }

  run('git', ['-C', sourceDir, 'submodule', 'sync', '--recursive']);
  run('git', ['-C', sourceDir, 'submodule', 'init', '--', HERMES_PATH]);
  run('git', [
    '-C', sourceDir, 'config', '--local', `submodule.${HERMES_PATH}.url`, hermesCheckout,
  ]);
  run('git', [
    '-C', sourceDir, 'config', '--local', `submodule.${HERMES_PATH}.active`, 'true',
  ]);
  const submoduleStatus = output('git', [
    '-C', sourceDir, 'submodule', 'status', '--recursive', '--', HERMES_PATH,
  ]);
  if (!submoduleStatus || submoduleStatus.startsWith('-') || submoduleStatus.startsWith('+')) {
    fail(`Gplus Hermes submodule is not initialized at the locked commit: ${submoduleStatus || HERMES_PATH}`);
  }
  console.log(`[macos-hermes] verified ${identity.tag}@${identity.commit} and source tree ${actualTree}`);
  return hermesCheckout;
}

async function main() {
  const { sourceDir } = parseArguments(process.argv.slice(2));
  githubToken();
  const { upstream } = loadHermesLock(sourceDir);
  const identity = readExpectedIdentity(sourceDir, upstream);
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'gplus-hermes-source-'));
  const hermesCheckout = path.join(sourceDir, HERMES_PATH);
  try {
    const archivePath = await downloadHermesArchive(tempRoot, identity.commit);
    const listing = output('tar', ['-tzf', archivePath]);
    validateArchiveListing(listing);
    prepareCheckout({ sourceDir, archivePath, identity });
  } catch (error) {
    rmSync(hermesCheckout, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
