[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateRange(1, [long]::MaxValue)][long] $RunId,
  [Parameter(Mandatory = $true)][ValidateSet('staging', 'production')][string] $Profile,
  [Parameter(Mandatory = $true)][string] $CertificateSha1,
  [string] $Repository = 'loulin/gplus-runner',
  [string] $GithubToken = $env:GH_RELEASE_ARTIFACT_TOKEN,
  [string] $ResponseDirectory = (Join-Path $env:USERPROFILE '.gplus\gplus-desktop-digest-responses'),
  [ValidateRange(1, 2)][int] $ExpectedRounds = 2,
  [ValidateRange(5, 300)][int] $PollSeconds = 15,
  [ValidateRange(1, 45)][int] $TimeoutMinutes = 40,
  [string] $SignToolPath,
  [ValidateRange(1, 5)][int] $SigningAttempts = 3,
  [switch] $SkipCallbackUpload
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Require-NonEmptyString {
  param([object] $Value, [string] $Label)
  $text = [string] $Value
  if ([string]::IsNullOrWhiteSpace($text)) { throw "$Label is required" }
  return $text.Trim()
}

function Get-RequiredProperty {
  param([object] $Object, [string] $Name, [string] $Label)
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { throw "$Label is missing field: $Name" }
  return $property.Value
}

function Get-FileDescriptor {
  param([Parameter(Mandatory = $true)][string] $Path)
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer) { throw "Expected a file: $Path" }
  return [ordered]@{
    name = $item.Name
    size = [int64] $item.Length
    sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

function Resolve-RequestFile {
  param(
    [Parameter(Mandatory = $true)][string] $Root,
    [Parameter(Mandatory = $true)][string] $RelativePath,
    [Parameter(Mandatory = $true)][string] $Label
  )
  if ([IO.Path]::IsPathRooted($RelativePath) -or $RelativePath -match '(^|[\\/])\.\.([\\/]|$)') {
    throw "$Label must be a relative path inside the request artifact"
  }
  $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $resolved = [IO.Path]::GetFullPath((Join-Path $rootPath $RelativePath))
  $prefix = "$rootPath$([IO.Path]::DirectorySeparatorChar)"
  if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label escapes the request artifact"
  }
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "$Label is missing: $RelativePath" }
  return $resolved
}

function Get-GithubToken {
  param([string] $Token)
  if (-not [string]::IsNullOrWhiteSpace($Token)) { return $Token.Trim() }
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  if ($null -eq $gh) { throw 'Set GH_RELEASE_ARTIFACT_TOKEN/GH_TOKEN or install gh and authenticate it' }
  $resolved = (& $gh.Source auth token).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($resolved)) {
    throw 'Unable to obtain a GitHub token from gh auth token'
  }
  return $resolved
}

function Get-RunAttempt {
  param([Parameter(Mandatory = $true)][hashtable] $Headers, [string] $Repo, [long] $WorkflowRunId)
  $run = Invoke-RestMethod -Headers $Headers -Uri "https://api.github.com/repos/$Repo/actions/runs/$WorkflowRunId"
  $attempt = [int](Get-RequiredProperty $run 'run_attempt' 'workflow run')
  if ($attempt -lt 1) { throw 'Workflow run attempt must be positive' }
  return $attempt
}

function Get-RequestArtifact {
  param(
    [Parameter(Mandatory = $true)][hashtable] $Headers,
    [Parameter(Mandatory = $true)][string] $Repo,
    [Parameter(Mandatory = $true)][long] $WorkflowRunId,
    [Parameter(Mandatory = $true)][int] $WorkflowRunAttempt,
    [Parameter(Mandatory = $true)][int] $Round
  )
  $name = "digest-request-$WorkflowRunId-$WorkflowRunAttempt-round-$Round"
  $result = Invoke-RestMethod -Headers $Headers -Uri "https://api.github.com/repos/$Repo/actions/runs/$WorkflowRunId/artifacts"
  return @($result.artifacts | Where-Object { $_.name -eq $name -and -not $_.expired }) | Select-Object -First 1
}

function Download-RequestArtifact {
  param(
    [Parameter(Mandatory = $true)][object] $Artifact,
    [Parameter(Mandatory = $true)][hashtable] $Headers,
    [Parameter(Mandatory = $true)][string] $Destination
  )
  Invoke-WebRequest -Headers $Headers -Uri $Artifact.archive_download_url -OutFile $Destination
  Expand-Archive -LiteralPath $Destination -DestinationPath ([IO.Path]::GetDirectoryName($Destination)) -Force
}

function Invoke-SignedDigest {
  param(
    [Parameter(Mandatory = $true)][string] $ToolPath,
    [Parameter(Mandatory = $true)][string] $CertificateThumbprint,
    [Parameter(Mandatory = $true)][string] $DigestPath,
    [Parameter(Mandatory = $true)][int] $Attempts
  )
  $signedPath = "$DigestPath.signed"
  if (Test-Path -LiteralPath $signedPath -PathType Leaf) { Remove-Item -LiteralPath $signedPath -Force }
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $toolOutput = @(& $ToolPath sign /ds /sha1 $CertificateThumbprint /fd SHA256 $DigestPath 2>&1)
    $toolExitCode = $LASTEXITCODE
    foreach ($line in $toolOutput) { Write-Host ([string]$line) }
    if ($toolExitCode -eq 0 -and (Test-Path -LiteralPath $signedPath -PathType Leaf) -and (Get-Item -LiteralPath $signedPath).Length -gt 0) {
      return $signedPath
    }
    if ($attempt -lt $Attempts) { Start-Sleep -Seconds (5 * $attempt) }
  }
  throw "signtool /ds did not produce a signed digest for $DigestPath"
}

function Invoke-QiniuUpload {
  param(
    [Parameter(Mandatory = $true)][string] $UploadUrl,
    [Parameter(Mandatory = $true)][string] $UploadToken,
    [Parameter(Mandatory = $true)][string] $ObjectKey,
    [Parameter(Mandatory = $true)][string] $Path
  )
  $uri = [Uri] $UploadUrl
  if ($uri.Scheme -ne 'https') { throw 'callback upload URL must use HTTPS' }
  $client = [System.Net.Http.HttpClient]::new()
  $content = [System.Net.Http.MultipartFormDataContent]::new()
  $stream = $null
  try {
    $content.Add([System.Net.Http.StringContent]::new($UploadToken), 'token')
    $content.Add([System.Net.Http.StringContent]::new($ObjectKey), 'key')
    $stream = [IO.File]::OpenRead($Path)
    $fileContent = [System.Net.Http.StreamContent]::new($stream)
    $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/octet-stream')
    $content.Add($fileContent, 'file', [IO.Path]::GetFileName($Path))
    $response = $client.PostAsync($uri, $content).GetAwaiter().GetResult()
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) { throw "Qiniu callback upload failed with HTTP $([int]$response.StatusCode)" }
    $uploaded = $body | ConvertFrom-Json
    if ((Require-NonEmptyString (Get-RequiredProperty $uploaded 'key' 'Qiniu response') 'Qiniu response key') -cne $ObjectKey) {
      throw 'Qiniu callback response key does not match the requested object key'
    }
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    $content.Dispose()
    $client.Dispose()
  }
}

function Test-CompletedRound {
  param([string] $ReceiptPath)
  if (-not (Test-Path -LiteralPath $ReceiptPath -PathType Leaf)) { return $false }
  $receipt = Get-Content -LiteralPath $ReceiptPath -Raw | ConvertFrom-Json
  return [bool] $receipt.callbackUploaded
}

$certificateSha1 = Require-NonEmptyString $CertificateSha1 'CertificateSha1'
if ($certificateSha1 -notmatch '^[0-9a-fA-F]{40}$') { throw 'CertificateSha1 must be a 40-character hexadecimal thumbprint' }
$token = Get-GithubToken $GithubToken
$headers = @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
if ([string]::IsNullOrWhiteSpace($SignToolPath)) {
  $signTool = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($null -eq $signTool) { $signTool = Get-Command signtool -ErrorAction SilentlyContinue }
  if ($null -eq $signTool) { throw 'signtool.exe is required on PATH or pass -SignToolPath' }
  $SignToolPath = $signTool.Source
} else {
  $SignToolPath = [IO.Path]::GetFullPath($SignToolPath)
  if (-not (Test-Path -LiteralPath $SignToolPath -PathType Leaf)) { throw "signtool.exe is missing: $SignToolPath" }
}

$runAttempt = Get-RunAttempt -Headers $headers -Repo $Repository -WorkflowRunId $RunId
$responseRoot = [IO.Path]::GetFullPath($ResponseDirectory)
New-Item -ItemType Directory -Path $responseRoot -Force | Out-Null
$deadline = [DateTimeOffset]::UtcNow.AddMinutes($TimeoutMinutes)

for ($round = 1; $round -le $ExpectedRounds; $round++) {
  $receiptPath = Join-Path $responseRoot "run-$RunId-attempt-$runAttempt-round-$round.receipt.json"
  if (Test-CompletedRound $receiptPath) {
    Write-Output "Round $round was already uploaded according to $receiptPath"
    continue
  }

  $artifact = $null
  while ($null -eq $artifact) {
    if ([DateTimeOffset]::UtcNow -ge $deadline) { throw "Timed out waiting for round $round digest request from run $RunId attempt $runAttempt" }
    $artifact = Get-RequestArtifact -Headers $headers -Repo $Repository -WorkflowRunId $RunId -WorkflowRunAttempt $runAttempt -Round $round
    if ($null -eq $artifact) { Start-Sleep -Seconds $PollSeconds }
  }

  $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "gplus-digest-sign-$RunId-$runAttempt-$round-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
  try {
    Download-RequestArtifact -Artifact $artifact -Headers $headers -Destination (Join-Path $temporaryRoot 'request-artifact.zip')
    $manifestPath = Join-Path $temporaryRoot 'request-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Digest request artifact is missing request-manifest.json' }
    $request = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ((Require-NonEmptyString (Get-RequiredProperty $request 'kind' 'signing request') 'signing request kind') -cne 'gplus-windows-digest-request') { throw 'Unexpected signing request kind' }
    foreach ($field in @('exchangeId', 'expiresAt', 'app', 'profile', 'channel', 'target', 'workflowRunId', 'workflowRunAttempt', 'round', 'hashAlgorithm', 'timestampServer', 'provenance', 'files', 'callback')) { Get-RequiredProperty $request $field 'signing request' | Out-Null }
    if ([long]$request.workflowRunId -ne $RunId -or [int]$request.workflowRunAttempt -ne $runAttempt -or [int]$request.round -ne $round -or [string]$request.profile -cne $Profile) {
      throw 'Signing request identity does not match the requested run, attempt, round, or profile'
    }
    if ([DateTimeOffset]::Parse([string]$request.expiresAt).ToUniversalTime() -le [DateTimeOffset]::UtcNow) { throw 'Signing request has expired' }
    if ([string]$request.hashAlgorithm -cne 'SHA256') { throw 'Signing request hash algorithm must be SHA256' }
    $provenance = $request.provenance
    $sourceSha = Require-NonEmptyString (Get-RequiredProperty $provenance 'sourceSha' 'request provenance') 'request provenance sourceSha'
    if ($sourceSha -notmatch '^[0-9a-f]{40}$') { throw 'Request provenance sourceSha must be a full lower-case SHA' }
    $app = Require-NonEmptyString $request.app 'signing request app'
    $channel = Require-NonEmptyString $request.channel 'signing request channel'
    $target = Require-NonEmptyString $request.target 'signing request target'
    Write-Output "Signing $app $Profile/$target round $round from $sourceSha (channel $channel)"
    $callback = $request.callback
    $uploadUrl = Require-NonEmptyString (Get-RequiredProperty $callback 'uploadUrl' 'callback') 'callback uploadUrl'
    $uploadToken = Require-NonEmptyString (Get-RequiredProperty $callback 'uploadToken' 'callback') 'callback uploadToken'
    $objectKey = Require-NonEmptyString (Get-RequiredProperty $callback 'objectKey' 'callback') 'callback objectKey'
    $maxResponseBytes = [int64](Get-RequiredProperty $callback 'maxResponseBytes' 'callback')
    if ($maxResponseBytes -lt 1) { throw 'callback maxResponseBytes must be positive' }
    if ($objectKey -notmatch "^signing-callbacks/$([regex]::Escape([string]$request.channel))/$([regex]::Escape([string]$request.target))/$RunId-$runAttempt/round-$round-$([regex]::Escape([string]$request.exchangeId))\.zip$") {
      throw 'Callback object key does not match the requested run, target, and exchange'
    }

    $responseRootForRound = Join-Path $temporaryRoot 'response'
    $signedRoot = Join-Path $responseRootForRound 'signed'
    New-Item -ItemType Directory -Path $signedRoot -Force | Out-Null
    $signedFiles = @()
    $index = 0
    foreach ($record in @($request.files)) {
      $index++
      $fileId = Require-NonEmptyString (Get-RequiredProperty $record 'fileId' "signing request file $index") "signing request file $index fileId"
      if ($fileId -notmatch '^[a-z0-9][a-z0-9-]{0,127}$') { throw "Signing request file $index fileId is invalid" }
      $digestRelativePath = Require-NonEmptyString (Get-RequiredProperty $record 'digRelativePath' "signing request file $index") "signing request file $index digRelativePath"
      $digestPath = Resolve-RequestFile -Root $temporaryRoot -RelativePath $digestRelativePath -Label "signing request digest $index"
      $digest = Get-FileDescriptor -Path $digestPath
      $expectedDigestHash = Require-NonEmptyString (Get-RequiredProperty $record 'digSha256' "signing request file $index") "signing request file $index digSha256"
      if ($digest.sha256 -cne $expectedDigestHash.ToLowerInvariant()) { throw "Signing request digest $index SHA-256 mismatch" }
      $signedDigest = Invoke-SignedDigest -ToolPath $SignToolPath -CertificateThumbprint $certificateSha1 -DigestPath $digestPath -Attempts $SigningAttempts
      $signedRelativePath = "signed/$fileId/file.dig.signed"
      $signedPath = Join-Path $responseRootForRound $signedRelativePath
      New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($signedPath)) -Force | Out-Null
      Copy-Item -LiteralPath $signedDigest -Destination $signedPath -Force
      $signedFiles += [ordered]@{
        fileId = $fileId
        signedRelativePath = $signedRelativePath
        signedSha256 = (Get-FileDescriptor -Path $signedPath).sha256
      }
    }
    if ($signedFiles.Count -eq 0) { throw 'Signing request has no digest files' }

    $response = [ordered]@{
      schemaVersion = 1
      kind = 'gplus-windows-digest-response'
      exchangeId = [string]$request.exchangeId
      requestManifestSha256 = (Get-FileDescriptor -Path $manifestPath).sha256
      completedAt = [DateTimeOffset]::UtcNow.ToString('o')
      signingCertificateSha1 = $certificateSha1.ToUpperInvariant()
      timestampApplied = $false
      files = $signedFiles
    }
    $responseManifest = Join-Path $responseRootForRound 'response-manifest.json'
    [IO.File]::WriteAllText($responseManifest, ($response | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    $responseArchive = Join-Path $temporaryRoot "signed-response-$($request.exchangeId).zip"
    Compress-Archive -Path (Join-Path $responseRootForRound '*') -DestinationPath $responseArchive -CompressionLevel Optimal
    $responseDescriptor = Get-FileDescriptor -Path $responseArchive
    if ($responseDescriptor.size -gt $maxResponseBytes) { throw "Signed response exceeds callback maxResponseBytes: $($responseDescriptor.size) > $maxResponseBytes" }
    $localArchivePath = Join-Path $responseRoot "run-$RunId-attempt-$runAttempt-round-$round-signed-response-$($request.exchangeId).zip"
    Copy-Item -LiteralPath $responseArchive -Destination $localArchivePath -Force
    if (-not $SkipCallbackUpload) {
      Invoke-QiniuUpload -UploadUrl $uploadUrl -UploadToken $uploadToken -ObjectKey $objectKey -Path $responseArchive
    }
    $receipt = [ordered]@{
      schemaVersion = 1
      kind = 'gplus-windows-digest-local-receipt'
      workflowRunId = $RunId
      workflowRunAttempt = $runAttempt
      round = $round
      exchangeId = [string]$request.exchangeId
      sourceSha = $sourceSha
      responseArchive = $responseDescriptor
      localArchivePath = $localArchivePath
      objectKey = $objectKey
      callbackUploaded = -not $SkipCallbackUpload
      completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    }
    [IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Write-Output "Signed digest round $round for run $RunId attempt $runAttempt; callback uploaded: $(-not $SkipCallbackUpload)"
  } finally {
    if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
  }
}
