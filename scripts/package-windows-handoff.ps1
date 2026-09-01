[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $SourceRoot,
  [Parameter(Mandatory = $true)]
  [string] $TargetRoot,
  [Parameter(Mandatory = $true)]
  [string] $ReleaseDir,
  [Parameter(Mandatory = $true)]
  [string] $BuildManifestPath,
  [Parameter(Mandatory = $true)]
  [string] $OutputDirectory,
  [Parameter(Mandatory = $true)]
  [string] $AgePath,
  [Parameter(Mandatory = $true)]
  [string] $Recipient,
  [Parameter(Mandatory = $true)]
  [string] $AgeVersion,
  [Parameter(Mandatory = $true)]
  [string] $SourceRef,
  [Parameter(Mandatory = $true)]
  [string] $SourceSha,
  [Parameter(Mandatory = $true)]
  [string] $HermesSha,
  [Parameter(Mandatory = $true)]
  [string] $Channel,
  [Parameter(Mandatory = $true)]
  [string] $Target,
  [Parameter(Mandatory = $true)]
  [string] $Version,
  [Parameter(Mandatory = $true)]
  [int] $BuildNumber,
  [Parameter(Mandatory = $true)]
  [long] $RunId,
  [Parameter(Mandatory = $true)]
  [int] $RunAttempt
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

function Assert-OutsideRoot {
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
    $resolvedPath.Equals($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $resolvedPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
  ) {
    throw "$Label must be outside ${resolvedRoot}: $resolvedPath"
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

function Get-FileRecord {
  param(
    [Parameter(Mandatory = $true)]
    [System.IO.FileInfo] $File
  )

  [ordered]@{
    path = Get-RelativePortablePath -BasePath $script:StagingRoot -Path $File.FullName
    size = [int64] $File.Length
    sha256 = (Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
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

foreach ($entry in @(
    @{ Value = $AgeVersion; Label = 'Age version' },
    @{ Value = $Recipient; Label = 'Age recipient' },
    @{ Value = $SourceRef; Label = 'Source ref' },
    @{ Value = $SourceSha; Label = 'Source SHA' },
    @{ Value = $HermesSha; Label = 'Hermes SHA' },
    @{ Value = $Channel; Label = 'Channel' },
    @{ Value = $Target; Label = 'Target' },
    @{ Value = $Version; Label = 'Version' }
  )) {
  Assert-SafeText -Value $entry.Value -Label $entry.Label
}

if ($AgeVersion -notmatch '^\d+\.\d+\.\d+$') {
  throw "Age version is not pinned to a numeric release: $AgeVersion"
}
if ($Recipient -notmatch '^age1[a-z0-9]+$') {
  throw 'Age recipient must be an age X25519 recipient'
}
if ($SourceSha -notmatch '^[0-9a-fA-F]{40}$' -or $HermesSha -notmatch '^[0-9a-fA-F]{40}$') {
  throw 'Source SHA and Hermes SHA must be full 40-character hexadecimal values'
}
if ($Channel -ne 'staging' -or $Target -ne 'win-x64') {
  throw "This handoff packager is limited to staging/win-x64: $Channel/$Target"
}
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
  throw "Version is not semver: $Version"
}
if ($BuildNumber -lt 1 -or $RunId -lt 1 -or $RunAttempt -lt 1) {
  throw 'Build number, run ID, and run attempt must be positive'
}
if (-not (Test-Path -LiteralPath $AgePath -PathType Leaf)) {
  throw "Age executable is missing: $AgePath"
}

$resolvedSourceRoot = Resolve-FullPath $SourceRoot
$resolvedTargetRoot = Assert-WithinRoot -Path $TargetRoot -Root $resolvedSourceRoot -Label 'Generated target root'
$resolvedReleaseDir = Assert-WithinRoot -Path $ReleaseDir -Root $resolvedTargetRoot -Label 'Release directory'
$resolvedBuildManifestPath = Assert-WithinRoot -Path $BuildManifestPath -Root $resolvedSourceRoot -Label 'Build manifest'
$resolvedOutputDirectory = Assert-OutsideRoot -Path $OutputDirectory -Root $resolvedSourceRoot -Label 'Handoff output directory'

foreach ($requiredPath in @($resolvedSourceRoot, $resolvedTargetRoot, $resolvedReleaseDir, $resolvedBuildManifestPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "Required handoff input is missing: $requiredPath"
  }
}
if (-not (Test-Path -LiteralPath $resolvedBuildManifestPath -PathType Leaf)) {
  throw "Build manifest is not a file: $resolvedBuildManifestPath"
}

$temporaryRoot = $null
try {
  $buildManifest = Get-Content -LiteralPath $resolvedBuildManifestPath -Raw | ConvertFrom-Json
  if ([string]$buildManifest.sourceRepository -ne 'loulin/gplus') {
    throw 'Build manifest source repository is not loulin/gplus'
  }
  foreach ($field in @('sourceRef', 'sourceSha', 'hermesSha', 'channel', 'target', 'version', 'buildNumber')) {
    if ($null -eq $buildManifest.$field) {
      throw "Build manifest is missing field: $field"
    }
  }
  if ([string]$buildManifest.sourceRef -ne $SourceRef) {
    throw 'Build manifest sourceRef does not match workflow input'
  }
  if ([string]$buildManifest.sourceSha -ne $SourceSha.ToLowerInvariant()) {
    throw 'Build manifest sourceSha does not match checked out source'
  }
  if ([string]$buildManifest.hermesSha -ne $HermesSha.ToLowerInvariant()) {
    throw 'Build manifest hermesSha does not match checked out Hermes'
  }
  if ([string]$buildManifest.channel -ne $Channel -or [string]$buildManifest.target -ne $Target) {
    throw 'Build manifest channel or target does not match handoff'
  }
  if ([string]$buildManifest.version -ne $Version -or [int]$buildManifest.buildNumber -ne $BuildNumber) {
    throw 'Build manifest version or buildNumber does not match handoff'
  }

  $outputParent = Split-Path -Parent $resolvedOutputDirectory
  New-Item -ItemType Directory -Path $outputParent -Force | Out-Null
  if (Test-Path -LiteralPath $resolvedOutputDirectory) {
    if (@(Get-ChildItem -LiteralPath $resolvedOutputDirectory -Force).Count -ne 0) {
      throw "Handoff output directory must be empty: $resolvedOutputDirectory"
    }
  } else {
    New-Item -ItemType Directory -Path $resolvedOutputDirectory -Force | Out-Null
  }

  $temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("gplus-desktop-handoff-" + [guid]::NewGuid().ToString('N'))
  $script:StagingRoot = Join-Path $temporaryRoot 'payload'
  $archivePath = Join-Path $temporaryRoot 'handoff.zip'
  $handoffName = "gplus-bot-desktop-staging-$Target-$Version-run-$RunId.zip.age"
  $ciphertextPath = Join-Path $resolvedOutputDirectory $handoffName
  $publicManifestPath = Join-Path $resolvedOutputDirectory "gplus-bot-desktop-staging-$Target-$Version-run-$RunId.ciphertext-manifest.json"
  New-Item -ItemType Directory -Path $script:StagingRoot -Force | Out-Null

  $prepackagedPath = Join-Path $resolvedReleaseDir 'win-unpacked'
  if (-not (Test-Path -LiteralPath $prepackagedPath -PathType Container)) {
    throw "Prepackaged Windows directory is missing: $prepackagedPath"
  }
  Copy-AllowedTree -SourcePath $prepackagedPath -DestinationRelativePath 'prepackaged/win-unpacked' -Label 'win-unpacked payload' | Out-Null

  $builderPackagePath = Join-Path $resolvedTargetRoot 'apps/desktop/package.json'
  Copy-AllowedFile -SourcePath $builderPackagePath -DestinationRelativePath 'builder/package.json'
  foreach ($scriptName in @('notarize.cjs', 'notarize-artifact.cjs', 'notarize-artifact-hook.cjs', 'sign-win-retry.cjs')) {
    Copy-AllowedFile -SourcePath (Join-Path $resolvedTargetRoot ("apps/desktop/scripts/$scriptName")) -DestinationRelativePath "builder/scripts/$scriptName"
  }

  $latestManifestPath = Join-Path $resolvedReleaseDir 'latest.yml'
  Copy-AllowedFile -SourcePath $latestManifestPath -DestinationRelativePath 'reference/latest.yml'
  $blockmaps = @(Get-ChildItem -LiteralPath $resolvedReleaseDir -Force -File | Where-Object { $_.Name.EndsWith('.blockmap', [System.StringComparison]::OrdinalIgnoreCase) })
  if ($blockmaps.Count -eq 0) {
    throw "No Windows blockmap was found in release directory: $resolvedReleaseDir"
  }
  foreach ($blockmap in $blockmaps) {
    Copy-AllowedFile -SourcePath $blockmap.FullName -DestinationRelativePath "reference/$($blockmap.Name)"
  }
  Copy-AllowedFile -SourcePath $resolvedBuildManifestPath -DestinationRelativePath 'build/staging-build-manifest.json'

  $payloadFiles = @(Get-ChildItem -LiteralPath $script:StagingRoot -Force -Recurse -File | Sort-Object FullName)
  if ($payloadFiles.Count -eq 0) {
    throw 'Handoff payload contains no files'
  }
  $fileRecords = @($payloadFiles | ForEach-Object { Get-FileRecord $_ })
  [int64] $plaintextBytes = 0
  foreach ($file in $payloadFiles) {
    $plaintextBytes += [int64] $file.Length
  }
  if ($plaintextBytes -gt [int64] 3GB) {
    throw "Plaintext handoff exceeds 3 GiB: $plaintextBytes bytes"
  }

  $innerManifestPath = Join-Path $script:StagingRoot 'handoff-manifest.json'
  $innerManifest = [ordered]@{
    schemaVersion = 1
    kind = 'gplus-bot-desktop-staging-windows-encrypted-handoff'
    sourceRepository = 'loulin/gplus'
    sourceRef = $SourceRef
    sourceSha = $SourceSha.ToLowerInvariant()
    hermesSha = $HermesSha.ToLowerInvariant()
    channel = $Channel
    target = $Target
    version = $Version
    buildNumber = $BuildNumber
    workflowRunId = $RunId
    workflowRunAttempt = $RunAttempt
    packageMode = 'unsigned-prepackaged-handoff'
    archiveFormat = 'zip'
    ageVersion = $AgeVersion
    ciphertextName = $handoffName
    files = $fileRecords
  }
  Write-Utf8NoBom -Path $innerManifestPath -Content (($innerManifest | ConvertTo-Json -Depth 20) + "`n")
  $innerManifestItem = Get-Item -LiteralPath $innerManifestPath -Force
  $innerManifestHash = (Get-FileHash -LiteralPath $innerManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $script:StagingRoot,
    $archivePath,
    [System.IO.Compression.CompressionLevel]::Fastest,
    $false
  )
  if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    throw "Handoff archive was not created: $archivePath"
  }

  & $AgePath '-r' $Recipient '-o' $ciphertextPath $archivePath | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "age failed to encrypt the handoff with status $LASTEXITCODE"
  }
  if (-not (Test-Path -LiteralPath $ciphertextPath -PathType Leaf)) {
    throw "Encrypted handoff was not created: $ciphertextPath"
  }
  $ageHeader = Get-AgeHeader $ciphertextPath
  if (-not $ageHeader.StartsWith('age-encryption.org/v1', [System.StringComparison]::Ordinal)) {
    throw 'Encrypted handoff does not have an age v1 header'
  }

  $ciphertextItem = Get-Item -LiteralPath $ciphertextPath -Force
  if ($ciphertextItem.Length -le 0 -or $ciphertextItem.Length -gt [int64] 2GB) {
    throw "Ciphertext handoff size is outside the allowed range: $($ciphertextItem.Length) bytes"
  }
  $publicManifest = [ordered]@{
    schemaVersion = 1
    kind = 'gplus-bot-desktop-staging-windows-ciphertext-manifest'
    sourceRepository = 'loulin/gplus'
    sourceRef = $SourceRef
    sourceSha = $SourceSha.ToLowerInvariant()
    hermesSha = $HermesSha.ToLowerInvariant()
    channel = $Channel
    target = $Target
    version = $Version
    buildNumber = $BuildNumber
    workflowRunId = $RunId
    workflowRunAttempt = $RunAttempt
    packageMode = 'unsigned-prepackaged-handoff'
    ageVersion = $AgeVersion
    ciphertext = [ordered]@{
      name = $handoffName
      size = [int64] $ciphertextItem.Length
      sha256 = (Get-FileHash -LiteralPath $ciphertextPath -Algorithm SHA256).Hash.ToLowerInvariant()
      format = 'age-encrypted-zip'
    }
    plaintext = [ordered]@{
      fileCount = [int] ($fileRecords.Count + 1)
      payloadBytes = $plaintextBytes
      manifestName = 'handoff-manifest.json'
      manifestSize = [int64] $innerManifestItem.Length
      manifestSha256 = $innerManifestHash
      layout = 'prepackaged/win-unpacked plus builder and reference metadata'
    }
  }
  Write-Utf8NoBom -Path $publicManifestPath -Content (($publicManifest | ConvertTo-Json -Depth 20) + "`n")
  Write-Output ($publicManifest | ConvertTo-Json -Depth 20)
} finally {
  if ($temporaryRoot -and (Test-Path -LiteralPath $temporaryRoot)) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
}
