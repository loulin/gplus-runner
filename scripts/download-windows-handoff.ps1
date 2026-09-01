[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][long] $RunId,
  [Parameter(Mandatory = $true)][string] $ArtifactName,
  [Parameter(Mandatory = $true)][string] $OutputDirectory,
  [Parameter(Mandatory = $true)][string] $Repository,
  [Parameter(Mandatory = $true)][string] $GithubToken
)

$ErrorActionPreference = 'Stop'
$headers = @{ Authorization = "Bearer $GithubToken"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
$artifact = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repository/actions/runs/$RunId/artifacts" |
  Select-Object -ExpandProperty artifacts | Where-Object { $_.name -eq $ArtifactName -and -not $_.expired } | Select-Object -First 1
if (-not $artifact) { throw "Active artifact not found: $ArtifactName" }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$zipPath = Join-Path (Resolve-Path $OutputDirectory) "$ArtifactName.zip"
Invoke-WebRequest -Headers $headers -Uri $artifact.archive_download_url -OutFile $zipPath
Expand-Archive -LiteralPath $zipPath -DestinationPath $OutputDirectory -Force
$manifestPath = Join-Path $OutputDirectory 'ciphertext-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'ciphertext-manifest.json is missing after download' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$payload = if ($manifest.ciphertext) { $manifest.ciphertext } else { $manifest.archive }
$payloadPath = Join-Path $OutputDirectory ([string]$payload.name)
if ((Get-FileHash -LiteralPath $payloadPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$payload.sha256) { throw 'Downloaded handoff SHA-256 mismatch' }
Invoke-RestMethod -Method Delete -Headers $headers -Uri "https://api.github.com/repos/$Repository/actions/artifacts/$($artifact.id)" | Out-Null
Remove-Item -LiteralPath $zipPath -Force
Write-Output "Downloaded and deleted artifact $ArtifactName (id $($artifact.id))"
