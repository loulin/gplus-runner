# macOS Desktop Release

`release-macos-desktop.yml` is the formal macOS publishing entry point for the
private `loulin/gplus` repository. It builds and publishes one application,
profile, and architecture per run:

```text
application: gplus-bot-desktop | libre-reader
profile: staging | production
target: mac-arm64 | mac-x64
tag: canonical annotated release tag in loulin/gplus
```

The workflow runs on a matching native host:

| Target | GitHub runner | Node architecture |
| --- | --- | --- |
| `mac-arm64` | `macos-14` | `arm64` |
| `mac-x64` | `macos-13` | `x64` |

Cross-building is rejected. A run performs the following complete path:

```text
annotated source tag
  -> tag and package provenance checks
  -> native Electron build
  -> Developer ID signing
  -> Apple notarization and stapling
  -> Qiniu upload and CDN refresh
  -> Release API registration
```

The application release scripts remain the source of truth for public URLs,
channel names, artifact names, signing verification, and Release API payloads.
The runner does not override `QINIU_BUCKET`, `QINIU_DOMAIN`, or
`RELEASE_API_BASE_URL`.

## GitHub configuration

The repository must have these two read-only source checkout secrets:

```text
GPLUS_SOURCE_READER_APP_ID
GPLUS_SOURCE_READER_PRIVATE_KEY
```

The `staging` and `production` Environments must each contain these nine
secrets. They are environment-scoped so Production remains behind its existing
required reviewer rule.

```text
ASC_ISSUER_ID
ASC_KEY_ID
ASC_KEY_P8_B64
MAC_DEVELOPER_ID_P12_B64
MAC_DEVELOPER_ID_P12_PASSWORD
MAC_DEVELOPER_ID_SHA1
QINIU_ACCESS_KEY
QINIU_SECRET_KEY
RELEASE_TOKEN
```

`ASC_KEY_P8_B64` is the base64 encoding of the App Store Connect API key file.
`MAC_DEVELOPER_ID_P12_B64` is the base64 encoding of the Developer ID
Application certificate bundle. The workflow decodes both files into
`$RUNNER_TEMP`, uses mode `600`, and removes them in an `always()` cleanup step.
The P12 password, Qiniu credentials, and Release API token are injected only
into the publishing step.

Do not add `MATCH_PASSWORD`, private keys, decoded certificates, or local
credential files to this repository. The macOS workflow uses the local P12
path directly and does not need Match to fetch a signing identity.

## Tag contract

Gplus Bot Desktop uses:

```text
staging:    gplus-bot-desktop-vX.Y.Z-rc.N
production: gplus-bot-desktop-vX.Y.Z
```

Libre Reader uses:

```text
staging:    libre-reader-vX.Y.Z-staging
production: libre-reader-vX.Y.Z
```

The tag must be annotated. Before any dependency installation or publishing,
the workflow verifies the raw tag object ID and peeled commit against
`git ls-remote`, checks that `HEAD` is the peeled commit, and checks the
application package version and positive build number.

Gplus tag messages must be exactly:

```text
release gplus-bot-desktop X.Y.Z[-rc.N]

source-ref: origin/<branch>
```

Libre Reader tag messages must be canonical JSON with exactly these fields:

```json
{"schemaVersion":1,"profile":"staging|production","version":"X.Y.Z[-staging]","sourceRef":"refs/heads/<branch>"}
```

The tag validation helper is
[`scripts/validate-macos-desktop-source.mjs`](../scripts/validate-macos-desktop-source.mjs).
It is intentionally independent of the private repository's dependencies.

## Run a release

Run from the public repository's workflow revision that contains the macOS
workflow. The source `tag` is in `loulin/gplus`; it is not the `--ref` of the
public runner repository.

Staging Gplus Bot Desktop arm64:

```bash
gh workflow run release-macos-desktop.yml \
  --repo loulin/gplus-runner \
  --ref main \
  -f application=gplus-bot-desktop \
  -f profile=staging \
  -f tag=gplus-bot-desktop-v0.2.2-rc.1 \
  -f target=mac-arm64
```

Staging Libre Reader arm64:

```bash
gh workflow run release-macos-desktop.yml \
  --repo loulin/gplus-runner \
  --ref main \
  -f application=libre-reader \
  -f profile=staging \
  -f tag=libre-reader-v3.1.5-staging \
  -f target=mac-arm64
```

Use the corresponding stable tag and `profile=production` for Production. The
Production job pauses at the protected `production` Environment until its
reviewer approves the run. Approval is required before signing credentials are
made available to the job.

Inspect the run:

```bash
gh run list --repo loulin/gplus-runner \
  --workflow release-macos-desktop.yml --limit 5
gh run watch <run-id> --repo loulin/gplus-runner --exit-status
```

A successful run has performed signing, notarization, Qiniu publication, CDN
refresh, and Release API registration. The job summary records the app,
profile, target, tag object, source SHA, source ref, version, and build number.
No installer is uploaded as a GitHub Actions artifact.

## Failure handling

The workflow fails closed at each boundary:

- A wrong runner architecture or a lightweight/moved/noncanonical tag stops the
  run before the build.
- Missing or invalid signing material stops the run before Electron Builder.
- A notarization rejection stops the run before Qiniu publication.
- A Qiniu or Release API failure leaves the command failed; rerun the same tag
  and target only after checking the remote state and the source release
  scripts' idempotency behavior.

The source checkout keeps the temporary GitHub App credential only because the
release scripts re-check remote tag identity. The final cleanup removes the
checkout extraheader and decoded macOS credentials. A GitHub-hosted runner is
ephemeral, but cleanup remains explicit for failure paths and auditability.
