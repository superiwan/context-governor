param(
    [Parameter(Mandatory = $true)]
    [string]$WorkspacePath,

    [string]$GovernorDir = "C:\Users\prohibit\.codex\tools\context-governor",

    [string]$MemoryDir = "C:\Users\prohibit\.codex\memories\context-governor",

    [string]$ThreadId = ""
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\context-governor-common.ps1"

$resolvedWorkspace = [System.IO.Path]::GetFullPath($WorkspacePath)
$workspaceKey = $resolvedWorkspace.ToLowerInvariant()
$workspaceMemoryDir = Ensure-WorkspaceMemoryDir -MemoryRoot $MemoryDir -WorkspacePath $resolvedWorkspace
$resolvedThreadId = $ThreadId
if ([string]::IsNullOrWhiteSpace($resolvedThreadId)) {
    $resolvedThreadId = $env:CODEX_THREAD_ID
}
$mappingPath = Join-Path $workspaceMemoryDir "workspace-sessions.json"
$mappings = Read-JsonFile -Path $mappingPath -Fallback @{}

if (-not $mappings.ContainsKey($workspaceKey)) {
    throw "No context governor session found for workspace: $resolvedWorkspace"
}

$workspaceEntry = $mappings[$workspaceKey]
if (-not [string]::IsNullOrWhiteSpace($resolvedThreadId) -and $workspaceEntry.ContainsKey("threads") -and $workspaceEntry["threads"].ContainsKey($resolvedThreadId)) {
    $sessionId = $workspaceEntry["threads"][$resolvedThreadId]["sessionId"]
} elseif ($workspaceEntry.ContainsKey("latestSessionId")) {
    $sessionId = $workspaceEntry["latestSessionId"]
} elseif ($workspaceEntry.ContainsKey("sessionId")) {
    $sessionId = $workspaceEntry["sessionId"]
} else {
    throw "No session mapping found for workspace: $resolvedWorkspace"
}

Push-Location $GovernorDir
try {
    Append-EventLog -MemoryDir $workspaceMemoryDir -SessionId $sessionId -WorkspacePath $resolvedWorkspace -ThreadId $resolvedThreadId -EventType "flush"
    node .\dist\src\cli.js flush --session $sessionId --memoryDir $workspaceMemoryDir
}
finally {
    Pop-Location
}
