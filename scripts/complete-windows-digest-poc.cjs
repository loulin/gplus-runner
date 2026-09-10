const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

const thumbprint = '3CED6633E1492ADC8CE396489C29A50062B15128';
const timestampServer = 'http://time.certum.pl';
const root = path.join(process.env.RUNNER_TEMP, 'gplus-complete-digest-poc');
const statePath = path.join(root, 'state.json');
const toolRequire = createRequire(path.join(process.env.RUNNER_TEMP, 'digest-poc-tools/package.json'));
const artifacts = new (toolRequire('@actions/artifact').DefaultArtifactClient)();
const yaml = toolRequire('js-yaml');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const hash = (file, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);
const ensure = (ok, message) => { if (!ok) throw new Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  ensure(!result.error && result.status === 0, `${path.basename(command)} failed: exit ${result.status}`);
  return result.stdout;
}
function ps(code, extraEnv = {}) {
  return run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', code], { env: { ...process.env, ...extraEnv } });
}
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
function inside(directory, relative) {
  ensure(typeof relative === 'string' && !path.isAbsolute(relative), 'Response path must be relative');
  const resolved = path.resolve(directory, relative);
  ensure(resolved.startsWith(path.resolve(directory) + path.sep), 'Response path escapes archive');
  return resolved;
}
function encoded(value) { return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_'); }
function mac(value) { return crypto.createHmac('sha1', process.env.QINIU_SECRET_KEY).update(value).digest('base64').replaceAll('+', '-').replaceAll('/', '_'); }
function uploadToken(bucket, key) {
  const policy = encoded(JSON.stringify({ scope: `${bucket}:${key}`, deadline: Math.floor(Date.now() / 1000) + 3600, insertOnly: 1, fsizeLimit: 1048576, deleteAfterDays: 1 }));
  return `${process.env.QINIU_ACCESS_KEY}:${mac(policy)}:${policy}`;
}
async function downloadResponse(state, key, output) {
  const deadline = Date.now() + 40 * 60 * 1000;
  while (Date.now() < deadline) {
    const resource = `${state.domain.replace(/\/$/, '')}/${key}?e=${Math.floor(Date.now() / 1000) + 120}`;
    const url = `${resource}&token=${process.env.QINIU_ACCESS_KEY}:${mac(resource)}`;
    let response;
    try { response = await fetch(url, { signal: AbortSignal.timeout(30000) }); }
    catch { console.log('Callback download transport error; retrying'); await sleep(15000); continue; }
    if (response.status === 404) { await response.body?.cancel(); await sleep(15000); continue; }
    ensure(response.ok, `Callback download failed: HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      ensure(size <= 1048576, 'Callback response exceeds 1 MiB');
      chunks.push(chunk);
    }
    fs.writeFileSync(output, Buffer.concat(chunks));
    return;
  }
  throw new Error('Timed out waiting for signed digest callback');
}
function verify(state, file) {
  run(state.signTool, ['verify', '/pa', '/all', '/v', file]);
  const value = ps('$a = Get-AuthenticodeSignature -LiteralPath $env:POC_PE; [pscustomobject]@{status=[string]$a.Status;signer=$a.SignerCertificate.Thumbprint;timestamp=$a.TimeStamperCertificate.Subject} | ConvertTo-Json -Compress', { POC_PE: file });
  const result = JSON.parse(value);
  ensure(result.status === 'Valid' && result.signer === thumbprint && result.timestamp?.startsWith('CN=Certum Timestamp '), 'Authenticode signer or timestamp verification failed');
  return { file: path.basename(file), size: fs.statSync(file).size, sha256: hash(file), ...result };
}
async function signRound(files, label) {
  const state = json(statePath);
  const round = state.round + 1;
  ensure(round <= 3 && files.length > 0, 'Unexpected digest signing round');
  const roundRoot = path.join(root, `round-${round}`);
  const requestRoot = path.join(roundRoot, 'request');
  fs.mkdirSync(requestRoot, { recursive: true });
  const records = files.map((file, index) => {
    const fileId = `file-${String(index + 1).padStart(5, '0')}`;
    const digestDir = path.join(roundRoot, 'private-digests', fileId);
    fs.mkdirSync(digestDir, { recursive: true });
    run(state.signTool, ['sign', '/dg', digestDir, '/fd', 'SHA256', '/f', state.publicCert, file]);
    const dig = path.join(digestDir, path.basename(file) + '.dig');
    const p7u = path.join(digestDir, path.basename(file) + '.p7u');
    const digRelativePath = `digests/${fileId}/${path.basename(dig)}`;
    const transferred = path.join(requestRoot, digRelativePath);
    fs.mkdirSync(path.dirname(transferred), { recursive: true });
    fs.copyFileSync(dig, transferred);
    return { fileId, relativePath: path.relative(state.unpacked, file).replaceAll('\\', '/'), digRelativePath, digSha256: hash(dig), p7uSha256: hash(p7u), originalSha256: hash(file) };
  });
  const exchangeId = crypto.randomUUID();
  const key = `signing-callbacks/staging/win-x64/${state.runId}-${state.attempt}/round-${round}-${exchangeId}.zip`;
  const request = {
    schemaVersion: 1, kind: 'gplus-windows-digest-request', exchangeId,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
    app: 'gplus-bot-desktop', profile: 'staging', channel: 'staging', target: 'win-x64',
    version: state.version, buildNumber: state.buildNumber, workflowRunId: state.runId, workflowRunAttempt: state.attempt,
    workflowRevision: process.env.GITHUB_SHA, round, roundLabel: label, hashAlgorithm: 'SHA256', timestampServer,
    provenance: { sourceRef: process.env.SOURCE_REF, sourceSha: process.env.SOURCE_SHA },
    callback: { uploadUrl: 'https://upload.qiniup.com', uploadToken: uploadToken(state.bucket, key), objectKey: key, maxResponseBytes: 1048576 }, files: records,
  };
  const manifestPath = path.join(requestRoot, 'request-manifest.json');
  save(manifestPath, request);
  await artifacts.uploadArtifact(`digest-request-${state.runId}-${state.attempt}-round-${round}`, walk(requestRoot), requestRoot, { retentionDays: 1 });
  console.log(`Waiting for round ${round}: ${label}, ${files.length} digests`);
  const responseZip = path.join(roundRoot, 'response.zip');
  await downloadResponse(state, key, responseZip);
  const responseRoot = path.join(roundRoot, 'response');
  ps('Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($env:POC_ZIP); try { foreach($e in $z.Entries) { $p=[IO.Path]::GetFullPath((Join-Path $env:POC_OUT $e.FullName)); if(-not $p.StartsWith($env:POC_OUT + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw "ZIP entry escapes response directory" } }; if(($z.Entries | Measure-Object Length -Sum).Sum -gt 1048576) { throw "Expanded callback exceeds 1 MiB" } } finally { $z.Dispose() }; Expand-Archive -LiteralPath $env:POC_ZIP -DestinationPath $env:POC_OUT', { POC_ZIP: responseZip, POC_OUT: responseRoot });
  const response = json(path.join(responseRoot, 'response-manifest.json'));
  ensure(response.kind === 'gplus-windows-digest-response' && response.exchangeId === exchangeId && response.requestManifestSha256 === hash(manifestPath) && response.signingCertificateSha1 === thumbprint && response.timestampApplied === false, 'Response identity does not match request');
  ensure(Array.isArray(response.files) && response.files.length === files.length && new Set(response.files.map(f => f.fileId)).size === files.length, 'Response file set does not match request');
  const verified = [];
  for (let i = 0; i < files.length; i++) {
    const record = records[i];
    const signed = response.files.find(f => f.fileId === record.fileId);
    ensure(signed, 'Missing signed file');
    const signedPath = inside(responseRoot, signed.signedRelativePath);
    ensure(hash(signedPath) === signed.signedSha256, 'Signed digest SHA-256 mismatch');
    const digestDir = path.join(roundRoot, 'private-digests', record.fileId);
    ensure(hash(files[i]) === record.originalSha256 && hash(path.join(digestDir, path.basename(files[i]) + '.p7u')) === record.p7uSha256, 'Build bytes changed before signature injection');
    fs.copyFileSync(signedPath, path.join(digestDir, path.basename(files[i]) + '.dig.signed'));
    run(state.signTool, ['sign', '/di', digestDir, files[i]]);
    for (let attempt = 1; ; attempt++) {
      try { run(state.signTool, ['timestamp', '/tr', timestampServer, '/td', 'SHA256', files[i]]); break; }
      catch (error) { if (attempt === 3) throw error; await sleep(attempt * 5000); }
    }
    verified.push(verify(state, files[i]));
  }
  state.round = round;
  state.rounds.push({ round, label, fileCount: files.length, responseBytes: fs.statSync(responseZip).size, responseSha256: hash(responseZip), verified });
  save(statePath, state);
  console.log(`Round ${round} verified: ${verified.length}/${files.length}`);
}
async function builder(state, format) {
  const requireDesktop = createRequire(path.join(state.desktop, 'package.json'));
  const cli = requireDesktop.resolve('electron-builder/cli.js');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--win', format, '--x64', '--prepackaged', state.unpacked, '--publish', 'never'], { cwd: state.desktop, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', GPLUS_DIGEST_POC_MODULE: __filename }, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`electron-builder ${format} failed: ${code}`)));
  });
}
async function main() {
  ensure(process.env.APPLICATION === 'gplus-bot-desktop' && process.env.PROFILE === 'staging' && process.env.TARGET === 'win-x64' && process.env.DELIVERY_MODE === 'digest', 'POC only supports staging win-x64 digest mode');
  ensure(process.env.QINIU_ACCESS_KEY && process.env.QINIU_SECRET_KEY, 'Qiniu callback credentials are required');
  fs.mkdirSync(root, { recursive: true });
  const source = path.join(process.env.GITHUB_WORKSPACE, 'source');
  const desktop = path.join(source, '.windows-handoff/payload/generated/apps/desktop');
  const unpacked = path.join(desktop, 'release/win-unpacked');
  ensure(fs.existsSync(unpacked), 'Prepared win-unpacked is missing');
  const config = Object.fromEntries(fs.readFileSync(path.join(source, 'config/storage/qiniu/staging.env'), 'utf8').split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1).trim()]; }));
  ensure(config.QINIU_BUCKET && /^https:\/\//.test(config.QINIU_DOMAIN), 'Staging storage configuration is missing');
  const signTool = ps('$p=Get-ChildItem "${env:ProgramFiles(x86)}/Windows Kits/10/bin" -Filter signtool.exe -Recurse -File | Where-Object {$_.Directory.Name -eq "x64"} | Sort-Object FullName -Descending | Select-Object -First 1; if(-not $p){throw "SignTool missing"}; $p.FullName').trim();
  const publicCert = path.join(root, 'public.cer');
  const cert = new crypto.X509Certificate(fs.readFileSync(path.join(__dirname, 'certum-code-signing-public.pem')));
  fs.writeFileSync(publicCert, cert.raw);
  ensure(hash(publicCert, 'sha1').toUpperCase() === thumbprint, 'Unexpected public signing certificate');
  const handoff = json(path.join(source, '.windows-handoff/handoff-manifest.json'));
  const state = { desktop, unpacked, signTool, publicCert, bucket: config.QINIU_BUCKET, domain: config.QINIU_DOMAIN, runId: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT), version: handoff.version, buildNumber: handoff.buildNumber, round: 0, rounds: [] };
  save(statePath, state);
  const executables = walk(unpacked).filter(file => file.toLowerCase().endsWith('.exe')).sort();
  await signRound(executables, 'app-executables');
  const signedHashes = new Map(executables.map(file => [file, hash(file)]));
  const packagePath = path.join(desktop, 'package.json');
  const pkg = json(packagePath);
  const publisherName = [cert.subject.split('\n').find(line => line.startsWith('CN=')).slice(3)];
  pkg.build.win = { ...pkg.build.win, signAndEditExecutable: true, signExecutable: true, verifyUpdateCodeSignature: true, signtoolOptions: { signingHashAlgorithms: ['sha256'], sign: path.join(__dirname, 'digest-poc-builder-hook.cjs'), publisherName } };
  pkg.build.artifactBuildCompleted = undefined;
  save(packagePath, pkg);
  // Prepackaged builds skip afterPack, which normally writes publisherName.
  const appUpdatePath = path.join(unpacked, 'resources/app-update.yml');
  const appUpdate = yaml.load(fs.readFileSync(appUpdatePath, 'utf8'));
  appUpdate.publisherName = publisherName;
  fs.writeFileSync(appUpdatePath, yaml.dump(appUpdate));
  const appUpdateHash = hash(appUpdatePath);
  await builder(state, 'zip');
  await builder(state, 'nsis');
  ensure(json(statePath).round === 3, 'Expected app, uninstaller, and installer signing rounds');
  for (const [file, expected] of signedHashes) ensure(hash(file) === expected, 'Packaging changed a signed application PE');
  ensure(hash(appUpdatePath) === appUpdateHash, 'Packaging changed the update publisher configuration');
  const release = path.dirname(unpacked);
  const files = fs.readdirSync(release).map(name => path.join(release, name)).filter(file => fs.statSync(file).isFile());
  const installers = files.filter(file => file.endsWith('.exe'));
  const zips = files.filter(file => file.endsWith('.zip'));
  ensure(installers.length === 1 && zips.length === 1, 'Expected one NSIS installer and one ZIP');
  const zipExpectedPath = path.join(root, 'zip-expected.json');
  save(zipExpectedPath, [...signedHashes, [appUpdatePath, appUpdateHash]].map(([file, sha256]) => ({ entry: path.relative(unpacked, file).replaceAll('\\', '/'), sha256 })));
  ps('Add-Type -AssemblyName System.IO.Compression.FileSystem; $expected=Get-Content -LiteralPath $env:POC_EXPECTED -Raw | ConvertFrom-Json; $z=[IO.Compression.ZipFile]::OpenRead($env:POC_ZIP); try { foreach($record in $expected) { $entry=$z.GetEntry($record.entry); if(-not $entry){throw "Expected ZIP entry missing"}; $stream=$entry.Open(); try {$actual=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant()} finally {$stream.Dispose()}; if($actual -cne $record.sha256){throw "ZIP entry hash mismatch"} }; Write-Output "ZIP PE and updater configuration hashes verified" } finally {$z.Dispose()}', { POC_EXPECTED: zipExpectedPath, POC_ZIP: zips[0] });
  verify(state, installers[0]);
  const requireDesktop = createRequire(packagePath);
  const appBuilder = requireDesktop('app-builder-bin').appBuilderPath;
  run(appBuilder, ['blockmap', '--input', installers[0], '--output', installers[0] + '.blockmap']);
  const metadata = yaml.load(fs.readFileSync(path.join(release, 'latest.yml'), 'utf8'));
  const descriptors = [...installers, ...zips].map(file => ({ url: path.basename(file), sha512: hash(file, 'sha512', 'base64'), size: fs.statSync(file).size }));
  const installerDescriptor = descriptors[0];
  ensure(metadata.sha512 === installerDescriptor.sha512 && metadata.files.some(file => file.url === installerDescriptor.url && file.sha512 === installerDescriptor.sha512 && file.size === installerDescriptor.size), 'Installer metadata does not match final signed bytes');
  metadata.files = descriptors;
  fs.writeFileSync(path.join(release, 'latest.yml'), yaml.dump(metadata));
  const receipt = { ...json(statePath), signToolVersion: ps('(Get-Item -LiteralPath $env:POC_TOOL).VersionInfo.FileVersion', { POC_TOOL: signTool }).trim(), sourceSha: process.env.SOURCE_SHA, workflowRevision: process.env.GITHUB_SHA, packageMode: 'signed-digest-poc', published: false, zipVerifiedEntries: signedHashes.size + 1, artifacts: [...installers, ...zips, installers[0] + '.blockmap', path.join(release, 'latest.yml')].map(file => ({ name: path.basename(file), size: fs.statSync(file).size, sha256: hash(file), sha512: hash(file, 'sha512', 'base64') })) };
  const receiptPath = path.join(root, 'poc-release-receipt.json');
  save(receiptPath, receipt);
  await artifacts.uploadArtifact(`digest-poc-verification-${state.runId}-${state.attempt}`, [receiptPath], root, { retentionDays: 7 });
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nDigest POC passed: ${executables.length} application PEs, signed NSIS uninstaller and installer, ZIP and regenerated metadata. No release published.\n`);
}
module.exports = { signRound };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
