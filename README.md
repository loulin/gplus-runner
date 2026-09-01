# gplus-runner

Public GitHub Actions runner for private `loulin/gplus` Bot Desktop Windows
builds. The public repository contains workflow code and operating documents;
the application source remains private.

## Current status

`Staging Windows Desktop Proof` is a manual workflow with these properties:

- `source_ref` accepts a private-repository branch or full 40-character commit
  SHA and defaults to `develop`.
- The job runs on native `windows-latest` x64 and currently builds `win-x64`.
- The GitHub App `gplus-source-reader` has `Contents: Read-only` access only to
  `loulin/gplus`.
- The job installs the filtered workspace, prepares the locked Hermes source,
  runs Desktop JavaScript smoke tests, and builds an unsigned NSIS/ZIP proof.
- Only a sanitized manifest is uploaded. It contains source identity, package
  metadata, file names, sizes, and SHA-256 values; it does not contain source
  code or the installer bytes.

The complete process and the remaining implementation work are in
[`docs/windows-desktop-release-plan.md`](docs/windows-desktop-release-plan.md).

The first successful end-to-end proof was run on 2026-08-31:

| Item | Value |
| --- | --- |
| Workflow run | [33420952901](https://github.com/loulin/gplus-runner/actions/runs/33420952901) |
| Source | `loulin/gplus@312b7df68092754c09483dab4b988f23eba706c7` |
| Channel / target | `staging` / `win-x64` |
| Version / build | `0.2.0-rc.36` / `1040` |
| Result | Windows proof succeeded in 13m20s |
| Uploaded artifact | `gplus-bot-desktop-staging-manifest-33420952901` |

This proves the hosted Windows checkout and unsigned packaging path. It does
not prove SimplySign signing, Qiniu upload, Release API registration, or a
production release.

## Required secrets

Configure these two repository secrets in `loulin/gplus-runner`:

- `GPLUS_SOURCE_READER_APP_ID`: the App ID for `gplus-source-reader`.
- `GPLUS_SOURCE_READER_PRIVATE_KEY`: the downloaded GitHub App `.pem` private
  key.

The App installation must remain limited to `loulin/gplus` and
`Contents: Read-only`. Never add Qiniu, Release API, Certum, SimplySign, or
Windows signing credentials to this public repository or its workflow.

## Run the staging proof

Use the Actions UI or run from a shell with `gh`:

```bash
gh workflow run build-staging.yml \
  --repo loulin/gplus-runner \
  --ref main \
  -f source_ref=develop
```

For a reproducible run, replace `develop` with the full private commit SHA.
The `--ref main` value selects the workflow revision in this public repository;
`source_ref` selects the private application revision.

Inspect the result with:

```bash
gh run list --repo loulin/gplus-runner --workflow build-staging.yml --limit 1
gh run watch <run-id> --repo loulin/gplus-runner --exit-status
gh run download <run-id> --repo loulin/gplus-runner \
  --name gplus-bot-desktop-staging-manifest-<run-id>
```

## Security rule

The private checkout is temporary runner state. The workflow uses a short-lived
GitHub App token, disables checkout credential persistence, and uploads only
the sanitized manifest. Do not change the workflow to upload `source/`, the
generated workspace, an unencrypted installer, or a private key.

Encrypted artifact handoff and local Windows signing are intentionally tracked
as future work rather than being implied by the current proof workflow.
