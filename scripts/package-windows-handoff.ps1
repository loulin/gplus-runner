[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $HandoffDirectory,
  [Parameter(Mandatory = $true)]
  [string] $OutputDirectory,
  [string] $AgePath,
  [string] $Recipient,
  [string] $AgeVersion,
  [ValidateSet('age', 'none')]
  [string] $Mode = 'age'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,
    [Parameter(Mandatory = $true)]
    [string] $Content
  )

  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Resolve-FullPath {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  return [System.IO.Path]::GetFullPath($Path)
}

function Trim-DirectorySeparators {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  $result = $Path
  while ($result.Length -gt 1 -and ($result.EndsWith('\') -or $result.EndsWith('/'))) {
    $result = $result.Substring(0, $result.Length - 1)
  }
  return $result
}

function Assert-WithinRoot {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,
    [Parameter(Mandatory = $true)]
    [string] $Root,
    [Parameter(Mandatory = $true)]
    [string] $Label
  )

  $resolvedPath = Resolve-FullPath $Path
  $resolvedRoot = Trim-DirectorySeparators (Resolve-FullPath $Root)
  $rootPrefix = $resolvedRoot + [System.IO.Path]::DirectorySeparatorChar
  if (
    -not $resolvedPath.Equals($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
    -not $resolvedPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
  ) {
    throw "$Label must stay under ${resolvedRoot}: $resolvedPath"
  }
  return $resolvedPath
}

function Assert-SafeText {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Value,
    [Parameter(Mandatory = $true)]
    [string] $Label
  )

  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Contains("`r") -or $Value.Contains("`n")) {
    throw "$Label must be non-empty and must not contain newlines"
  }
}

function Test-IsReparsePoint {
  param(
    [Parameter(Mandatory = $true)]
    [System.IO.FileSystemInfo] $Item
  )

  return (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Assert-NoReparseTree {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Root,
    [Parameter(Mandatory = $true)]
    [string] $Label
  )

  $rootItem = Get-Item -LiteralPath $Root -Force
  if (Test-IsReparsePoint $rootItem) {
    throw "$Label is a reparse point: $Root"
  }
  foreach ($item in @(Get-ChildItem -LiteralPath $Root -Force -Recurse)) {
    if (Test-IsReparsePoint $item) {
      throw "$Label contains a reparse point: $($item.FullName)"
    }
  }
}

function Get-RelativePortablePath {
  param(
    [Parameter(Mandatory = $true)]
    [string] $BasePath,
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  $relative = [System.IO.Path]::GetRelativePath((Resolve-FullPath $BasePath), (Resolve-FullPath $Path))
  if (
    $relative.Equals('..') -or
    $relative.StartsWith("..$([System.IO.Path]::DirectorySeparatorChar)") -or
    [System.IO.Path]::IsPathRooted($relative)
  ) {
    throw "Path escapes handoff root: $Path"
  }
  return $relative.Replace('\', '/')
}

function Copy-AllowedFile {
  param(
    [Parameter(Mandatory = $true)]
    [string] $SourcePath,
    [Parameter(Mandatory = $true)]
    [string] $DestinationRelativePath
  )

  $sourceItem = Get-Item -LiteralPath $SourcePath -Force
  if ($sourceItem.PSIsContainer) {
    throw "Allowed handoff file is a directory: $SourcePath"
  }
  if (Test-IsReparsePoint $sourceItem) {
    throw "Allowed handoff file is a reparse point: $SourcePath"
  }

  $destinationPath = Join-Path $script:StagingRoot ($DestinationRelativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
  Assert-WithinRoot -Path $destinationPath -Root $script:StagingRoot -Label 'Handoff destination' | Out-Null
  New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force | Out-Null
  Copy-Item -LiteralPath $sourceItem.FullName -Destination $destinationPath -Force
}

function Copy-AllowedTree {
  param(
    [Parameter(Mandatory = $true)]
    [string] $SourcePath,
    [Parameter(Mandatory = $true)]
    [string] $DestinationRelativePath,
    [Parameter(Mandatory = $true)]
    [string] $Label
  )

  Assert-NoReparseTree -Root $SourcePath -Label $Label
  $files = @(Get-ChildItem -LiteralPath $SourcePath -Force -Recurse -File)
  if ($files.Count -eq 0) {
    throw "$Label contains no files: $SourcePath"
  }
  foreach ($file in $files) {
    $relativePath = Get-RelativePortablePath -BasePath $SourcePath -Path $file.FullName
    Copy-AllowedFile -SourcePath $file.FullName -DestinationRelativePath "$DestinationRelativePath/$relativePath"
  }
  return $files.Count
}

function Get-Sha512Base64 {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  $sha512 = [System.Security.Cryptography.SHA512]::Create()
  try {
    $bytes = $sha512.ComputeHash([System.IO.File]::ReadAllBytes($Path))
  } finally {
    $sha512.Dispose()
  }
  return [Convert]::ToBase64String($bytes)
}

function Assert-HandoffPayloadManifest {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Root,
    [Parameter(Mandatory = $true)]
    $Manifest
  )

  $records = @($Manifest.files)
  if ($records.Count -eq 0) { throw 'Handoff manifest files must not be empty' }
  $expected = @{}
  foreach ($record in $records) {
    $relative = [string]$record.path
    if (
      [string]::IsNullOrWhiteSpace($relative) -or
      $relative.Contains('\') -or
      $relative.StartsWith('/') -or
      $relative -match '(^|/)\.\.(/|$)|(^|/)\.(/|$)'
    ) {
      throw "Handoff manifest payload path is invalid: $relative"
    }
    if ($expected.ContainsKey($relative)) { throw "Handoff manifest payload path is duplicated: $relative" }
    if ($null -eq $record.size -or [int64]$record.size -lt 0) { throw "Handoff manifest payload size is invalid: $relative" }
    if ([string]$record.sha256 -notmatch '^[0-9a-fA-F]{64}$' -or [string]::IsNullOrWhiteSpace([string]$record.sha512)) { throw "Handoff manifest payload digest is invalid: $relative" }
    $expected[$relative] = $record
  }

  $actual = @(Get-ChildItem -LiteralPath $Root -Force -Recurse -File)
  if ($actual.Count -ne $expected.Count) { throw "Handoff manifest payload file count mismatch: expected $($expected.Count), got $($actual.Count)" }
  foreach ($file in $actual) {
    $relative = Get-RelativePortablePath -BasePath $Root -Path $file.FullName
    if (-not $expected.ContainsKey($relative)) { throw "Unexpected handoff payload file: $relative" }
    $record = $expected[$relative]
    $sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    $sha512 = Get-Sha512Base64 -Path $file.FullName
    if ([int64]$file.Length -ne [int64]$record.size -or $sha256 -ne ([string]$record.sha256).ToUpperInvariant() -or $sha512 -ne [string]$record.sha512) {
      throw "Handoff manifest payload digest mismatch: $relative"
    }
  }
}

function Get-AgeHeader {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  $buffer = [byte[]]::new(64)
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $read = $stream.Read($buffer, 0, $buffer.Length)
  } finally {
    $stream.Dispose()
  }
  return [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
}

$resolvedHandoffDirectory = Resolve-FullPath $HandoffDirectory
  if (-not (Test-Path -LiteralPath $resolvedHandoffDirectory -PathType Container)) {
    throw "Handoff directory is missing: $resolvedHandoffDirectory"
  }
  $payloadRoot = Join-Path $resolvedHandoffDirectory 'payload'
  $manifestPath = Join-Path $resolvedHandoffDirectory 'handoff-manifest.json'
  $publicManifestPath = Join-Path $resolvedHandoffDirectory 'public-manifest.json'
  if (-not (Test-Path -LiteralPath $payloadRoot -PathType Container)) { throw "Handoff payload is missing: $payloadRoot" }
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Handoff manifest is missing: $manifestPath" }
  if (-not (Test-Path -LiteralPath $publicManifestPath -PathType Leaf)) { throw "Handoff public manifest is missing: $publicManifestPath" }
  $handoffManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  foreach ($field in @('sourceRepository', 'app', 'profile', 'channel', 'target', 'sourceSha', 'version', 'buildNumber', 'workflowRunId', 'workflowRunAttempt', 'artifactName')) {
    if ($null -eq $handoffManifest.$field) { throw "Handoff manifest is missing field: $field" }
  }
  if ([string]$handoffManifest.sourceRepository -ne 'loulin/gplus') { throw 'Handoff sourceRepository must be loulin/gplus' }
  if ([string]$handoffManifest.app -notin @('gplus-bot-desktop', 'libre-reader')) { throw "Unsupported handoff app: $($handoffManifest.app)" }
  if ([string]$handoffManifest.profile -notin @('staging', 'production')) { throw "Unsupported handoff profile: $($handoffManifest.profile)" }
  if ([string]$handoffManifest.target -notin @('win-x64', 'win-arm64', 'win-ia32')) { throw "Unsupported handoff target: $($handoffManifest.target)" }
  if ([string]$handoffManifest.packageMode -ne 'unsigned-build-handoff') { throw "Unsupported handoff packageMode: $($handoffManifest.packageMode)" }
  if ([string]$handoffManifest.sourceSha -notmatch '^[0-9a-fA-F]{40}$') { throw 'Handoff sourceSha must be a full commit SHA' }
  if ([int64]$handoffManifest.workflowRunId -lt 1 -or [int]$handoffManifest.workflowRunAttempt -lt 1) { throw 'Handoff workflow run identity must be positive' }
  $expectedArtifactName = "$($handoffManifest.app)-$($handoffManifest.profile)-$($handoffManifest.target)-handoff-$($handoffManifest.workflowRunId)"
  if ([string]$handoffManifest.artifactName -ne $expectedArtifactName) { throw 'Handoff artifactName does not match app/profile/target/run' }
  $publicManifest = Get-Content -LiteralPath $publicManifestPath -Raw | ConvertFrom-Json
  foreach ($field in @('schemaVersion', 'kind', 'sourceRepository', 'app', 'profile', 'channel', 'target', 'sourceRef', 'sourceSha', 'version', 'buildNumber', 'workflowRunId', 'workflowRunAttempt', 'artifactName', 'packageMode')) {
    if ([string]$publicManifest.$field -cne [string]$handoffManifest.$field) {
      throw "Public manifest does not match handoff manifest: $field"
    }
  }
  [int64] $payloadBytes = 0
  foreach ($record in @($handoffManifest.files)) { $payloadBytes += [int64]$record.size }
  if ([int]$publicManifest.payloadFileCount -ne @($handoffManifest.files).Count -or [int64]$publicManifest.payloadBytes -ne $payloadBytes) {
    throw 'Public manifest payload summary does not match handoff manifest'
  }
  if ([string]::IsNullOrWhiteSpace([string]$handoffManifest.payloadRoot)) { throw 'Handoff manifest payloadRoot is missing' }
  $payloadRootValue = [string]$handoffManifest.payloadRoot
  if ($payloadRootValue.Contains('\') -or $payloadRootValue.StartsWith('/') -or $payloadRootValue -match '(^|/)\.\.(/|$)|(^|/)\.(/|$)') {
    throw "Handoff manifest payloadRoot is not a portable relative path: $payloadRootValue"
  }
  $manifestPayloadRoot = Join-Path $payloadRoot ([string]$handoffManifest.payloadRoot)
  if (-not (Test-Path -LiteralPath $manifestPayloadRoot -PathType Container)) { throw "Handoff manifest payloadRoot is missing: $manifestPayloadRoot" }
  Assert-HandoffPayloadManifest -Root $manifestPayloadRoot -Manifest $handoffManifest
  Assert-NoReparseTree -Root $payloadRoot -Label 'handoff payload'
  if ($Mode -eq 'age') {
    if (-not (Test-Path -LiteralPath $AgePath -PathType Leaf)) { throw "Age executable is missing: $AgePath" }
    Assert-SafeText -Value $AgeVersion -Label 'Age version'
    Assert-SafeText -Value $Recipient -Label 'Age recipient'
    if ($AgeVersion -notmatch '^\d+\.\d+\.\d+$' -or $Recipient -notmatch '^age1[a-z0-9]+$') { throw 'Age version or recipient is invalid' }
  }

  $temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("gplus-windows-handoff-" + [guid]::NewGuid().ToString('N'))
  try {
    $archiveRoot = Join-Path $temporaryRoot 'archive'
    New-Item -ItemType Directory -Path $archiveRoot -Force | Out-Null
    $script:StagingRoot = $archiveRoot
    Copy-AllowedTree -SourcePath $payloadRoot -DestinationRelativePath 'payload' -Label 'handoff payload' | Out-Null
    Copy-AllowedFile -SourcePath $manifestPath -DestinationRelativePath 'handoff-manifest.json'
    $archivePath = Join-Path $temporaryRoot 'handoff.zip'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($archiveRoot, $archivePath, [System.IO.Compression.CompressionLevel]::Fastest, $false)
    $resolvedOutputDirectory = Resolve-FullPath $OutputDirectory
    if (Test-Path -LiteralPath $resolvedOutputDirectory) {
      if (@(Get-ChildItem -LiteralPath $resolvedOutputDirectory -Force).Count -ne 0) {
        throw "Handoff output directory must be empty: $resolvedOutputDirectory"
      }
    } else {
      New-Item -ItemType Directory -Path $resolvedOutputDirectory -Force | Out-Null
    }
    $archiveName = if ($Mode -eq 'age') { 'encrypted-handoff.age' } else { 'handoff.zip' }
    $archiveOutputPath = Join-Path $resolvedOutputDirectory $archiveName
    if ($Mode -eq 'age') {
      & $AgePath '-r' $Recipient '-o' $archiveOutputPath $archivePath | Out-Host
      if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $archiveOutputPath -PathType Leaf)) { throw 'age failed to encrypt handoff' }
      $header = Get-AgeHeader $archiveOutputPath
      if (-not $header.StartsWith('age-encryption.org/v1', [System.StringComparison]::Ordinal)) { throw 'Encrypted handoff does not have an age v1 header' }
    } else {
      Copy-Item -LiteralPath $archivePath -Destination $archiveOutputPath -Force
    }
    $ciphertextItem = Get-Item -LiteralPath $archiveOutputPath -Force
    # GitHub Actions artifacts support multi-gigabyte payloads.  The generated
    # Hermes workspace can legitimately exceed 2 GiB until the runtime-only
    # source filter is applied; keep this ceiling high enough for the current
    # production handoff while still rejecting unbounded output.
    if ($ciphertextItem.Length -le 0 -or $ciphertextItem.Length -gt [int64] 8GB) { throw "Ciphertext handoff size is outside the allowed range: $($ciphertextItem.Length) bytes" }
    $public = $publicManifest
    $format = if ($Mode -eq 'age') { 'age-encrypted-zip' } else { 'zip' }
    $digestRecord = [ordered]@{
      name = $archiveName; size = [int64]$ciphertextItem.Length;
      sha256 = (Get-FileHash -LiteralPath $archiveOutputPath -Algorithm SHA256).Hash.ToLowerInvariant();
      sha512 = Get-Sha512Base64 -Path $archiveOutputPath; format = $format
    }
    $public | Add-Member -NotePropertyName handoffEncryption -NotePropertyValue $Mode -Force
    if ($Mode -eq 'age') { $public | Add-Member -NotePropertyName ciphertext -NotePropertyValue $digestRecord -Force; $public | Add-Member -NotePropertyName ageVersion -NotePropertyValue $AgeVersion -Force }
    else { $public | Add-Member -NotePropertyName archive -NotePropertyValue $digestRecord -Force }
    $publicPath = Join-Path $resolvedOutputDirectory 'ciphertext-manifest.json'
    Write-Utf8NoBom -Path $publicPath -Content (($public | ConvertTo-Json -Depth 20) + "`n")
    $outputItems = @(Get-ChildItem -LiteralPath $resolvedOutputDirectory -Force)
    $unexpectedItems = @($outputItems | Where-Object {
        $_.PSIsContainer -or $_.Name -notin @($archiveName, 'ciphertext-manifest.json')
      })
    if ($outputItems.Count -ne 2 -or $unexpectedItems.Count -ne 0) {
      throw "Handoff output must contain only $archiveName and ciphertext-manifest.json"
    }
    Write-Output ($public | ConvertTo-Json -Depth 20)
  } finally {
    if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
  }
