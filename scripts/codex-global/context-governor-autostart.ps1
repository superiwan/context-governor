param(
    [string]$WorkspacePath,
    [string]$TaskName = "auto-session",
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"

$resolvedWorkspace = if ([string]::IsNullOrWhiteSpace($WorkspacePath)) {
    (Get-Location).Path
} else {
    [System.IO.Path]::GetFullPath($WorkspacePath)
}

$resumeScript = Join-Path $PSScriptRoot "context-governor-resume.ps1"
$initScript = Join-Path $PSScriptRoot "context-governor-init.ps1"

$resumed = $false

try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $resumeScript -WorkspacePath $resolvedWorkspace | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $resumed = $true
    }
} catch {
    $resumed = $false
}

if (-not $resumed) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $initScript -WorkspacePath $resolvedWorkspace -TaskName $TaskName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

if (-not $Quiet) {
    if ($resumed) {
        Write-Output "context-governor: resumed ($resolvedWorkspace)"
    } else {
        Write-Output "context-governor: initialized ($resolvedWorkspace)"
    }
}
