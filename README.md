# gplus-runner
Public GitHub Actions runner for private Gplus Bot Desktop Windows builds

## Current workflow

`Staging Windows Desktop Proof` is a manual proof workflow. It accepts a branch
name or a full commit SHA from `loulin/gplus`; the default is `develop`. It uses
the native `windows-latest` x64 runner and currently builds only `win-x64`.

The workflow checks out the private source with `gplus-source-reader`, initializes
the Hermes submodule, installs the filtered workspace, runs JavaScript contract
smoke tests, and produces an unsigned proof package. The full Desktop baseline
check is intentionally a separate follow-up because its Hermes Python test
environment can take a long time to resolve on a fresh runner. It uploads only a sanitized
manifest containing source identity, package metadata, artifact names, sizes, and
SHA-256 values. The installer is intentionally not uploaded until encrypted
handoff is implemented.

## Required repository secrets

Configure these secrets in `loulin/gplus-runner`:

- `GPLUS_SOURCE_READER_APP_ID`: the App ID for `gplus-source-reader`.
- `GPLUS_SOURCE_READER_PRIVATE_KEY`: the downloaded GitHub App `.pem` private key.

The App must be installed only on `loulin/gplus` with `Contents: Read-only`.
Qiniu, Release API, Certum, and signing credentials do not belong in this public
repository.

## Run

Open Actions, select `Staging Windows Desktop Proof`, choose `Run workflow`, and
enter a source branch or full commit SHA. The run summary and the short-lived
manifest artifact are the first proof gate; they do not constitute a signed or
published release.
