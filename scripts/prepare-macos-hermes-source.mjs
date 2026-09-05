#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERMES_PATH = 'apps/gplus-bot-desktop/vendor/hermes-agent';
const HERMES_URL = 'https://github.com/NousResearch/hermes-agent.git';
const HERMES_SSH_URL = 'git@github.com:NousResearch/hermes-agent.git';
const HERMES_REPOSITORY = 'NousResearch/hermes-agent';
const HERMES_TAG_PATTERN = /^v\d{4}\.\d+\.\d+(?:\.\d+)?$/u;
const GIT_OID_PATTERN = /^[0-9a-f]{40}$/u;
const GITHUB_SSH_HOST_FINGERPRINT = 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU';
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

function run(command, args, { cwd, env, timeoutMs } = {}) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env,
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

function hermesSshKey() {
  const encodedKey = process.env.HERMES_SOURCE_SSH_KEY?.trim();
  if (!encodedKey) fail('HERMES_SOURCE_SSH_KEY is required to fetch the public Hermes source');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encodedKey)) {
    fail('HERMES_SOURCE_SSH_KEY must be a base64-encoded OpenSSH private key');
  }
  const key = Buffer.from(encodedKey, 'base64').toString('utf8')
    .trim()
    .replace(/\r\n?/gu, '\n');
  if (!key.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----') && !key.startsWith('-----BEGIN RSA PRIVATE KEY-----')) {
    fail('HERMES_SOURCE_SSH_KEY does not decode to an OpenSSH private key');
  }
  return key;
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

export function hermesSshUrl() {
  return HERMES_SSH_URL;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function prepareSshEnvironment(tempRoot) {
  const sshKeyPath = path.join(tempRoot, 'id_ed25519');
  const knownHostsPath = path.join(tempRoot, 'known_hosts');
  writeFileSync(sshKeyPath, `${hermesSshKey()}\n`, { encoding: 'utf8', mode: 0o600 });
  run('ssh-keygen', ['-y', '-f', sshKeyPath]);
  const knownHosts = run('ssh-keyscan', [
    '-T', '30', '-p', '443', '-t', 'ed25519', 'ssh.github.com',
  ], { timeoutMs: GIT_FETCH_TIMEOUT_MS });
  writeFileSync(knownHostsPath, knownHosts, { encoding: 'utf8', mode: 0o600 });
  if (!knownHosts.trim()) fail('ssh-keyscan returned no host key for ssh.github.com');
  const hostFingerprint = output('ssh-keygen', ['-lf', knownHostsPath])
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u)[1])
    .find(Boolean);
  if (hostFingerprint !== GITHUB_SSH_HOST_FINGERPRINT) {
    fail(`unexpected ssh.github.com host key fingerprint: ${hostFingerprint || 'missing'}`);
  }
  return {
    GIT_SSH_COMMAND: [
      'ssh',
      '-i', shellQuote(sshKeyPath),
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${shellQuote(knownHostsPath)}`,
      '-o', 'HostName=ssh.github.com',
      '-p', '443',
    ].join(' '),
  };
}

function fetchWithRetry(repoPath, args, label, env) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      run('git', args, {
        cwd: repoPath,
        env,
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

function prepareCheckout({ sourceDir, identity, sshEnv }) {
  const hermesCheckout = path.join(sourceDir, HERMES_PATH);
  rmSync(hermesCheckout, { recursive: true, force: true });
  mkdirSync(hermesCheckout, { recursive: true, mode: 0o755 });
  run('git', ['init', '--quiet', hermesCheckout]);
  run('git', ['-C', hermesCheckout, 'config', 'core.autocrlf', 'false']);
  run('git', ['-C', hermesCheckout, 'config', 'core.symlinks', 'true']);
  run('git', ['-C', hermesCheckout, 'remote', 'add', 'origin', HERMES_SSH_URL]);

  fetchWithRetry(
    hermesCheckout,
    [
      '-c', 'protocol.version=2', 'fetch', '--no-tags', '--depth', '1', '--filter=blob:none',
      'origin', `refs/tags/${identity.tag}:refs/tags/${identity.tag}`,
    ],
    'Hermes commit fetch',
    sshEnv,
  );
  run('git', ['-C', hermesCheckout, 'checkout', '--detach', '--force', identity.commit], {
    env: sshEnv,
    timeoutMs: GIT_FETCH_TIMEOUT_MS,
  });

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
  const submoduleStatusEntries = submoduleStatus
    .split(/\r?\n/u)
    .filter(Boolean);
  if (
    submoduleStatusEntries.length === 0
    || submoduleStatusEntries.some((entry) => entry.startsWith('-') || entry.startsWith('+'))
  ) {
    fail(`Gplus Hermes submodule is not initialized at the locked commit: ${submoduleStatus || HERMES_PATH}`);
  }
  console.log(`[macos-hermes] verified ${identity.tag}@${identity.commit} and source tree ${actualTree}`);
  return hermesCheckout;
}

async function main() {
  const { sourceDir } = parseArguments(process.argv.slice(2));
  const { upstream } = loadHermesLock(sourceDir);
  const identity = readExpectedIdentity(sourceDir, upstream);
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'gplus-hermes-source-'));
  const hermesCheckout = path.join(sourceDir, HERMES_PATH);
  try {
    const sshEnv = prepareSshEnvironment(tempRoot);
    prepareCheckout({ sourceDir, identity, sshEnv });
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
