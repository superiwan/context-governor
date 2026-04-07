param(
    [Parameter(Mandatory = $true)]
    [string]$WorkspacePath,

    [string[]]$Goal = @(),
    [string[]]$Constraint = @(),
    [string[]]$Decision = @(),
    [string[]]$Todo = @(),
    [string[]]$Done = @(),
    [string[]]$Artifact = @(),

    [ValidateSet("assistant", "user", "system")]
    [string]$Role = "assistant",

    [string]$GovernorDir = "C:\Users\prohibit\.codex\tools\context-governor",

    [string]$MemoryDir = "C:\Users\prohibit\.codex\memories\context-governor",

    [string]$ThreadId = "",

    [switch]$FlushAfter,
    [switch]$CompactAfter
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

$lines = [System.Collections.Generic.List[string]]::new()
foreach ($item in $Goal) { if (-not [string]::IsNullOrWhiteSpace($item)) { $lines.Add("goal: $item") } }
foreach ($item in $Constraint) { if (-not [string]::IsNullOrWhiteSpace($item)) { $lines.Add("constraint: $item") } }
foreach ($item in $Decision) { if (-not [string]::IsNullOrWhiteSpace($item)) { $lines.Add("decision: $item") } }
foreach ($item in $Todo) { if (-not [string]::IsNullOrWhiteSpace($item)) { $lines.Add("todo: $item") } }
foreach ($item in $Done) { if (-not [string]::IsNullOrWhiteSpace($item)) { $lines.Add("done: $item") } }
foreach ($item in $Artifact) { if (-not [string]::IsNullOrWhiteSpace($item)) { $lines.Add("artifact: $item") } }

if ($lines.Count -eq 0) {
    throw "Checkpoint requires at least one structured item."
}

$content = [string]::Join([Environment]::NewLine, $lines)
Append-EventLog -MemoryDir $workspaceMemoryDir -SessionId $sessionId -WorkspacePath $resolvedWorkspace -ThreadId $resolvedThreadId -EventType "checkpoint" -Data @{
    goalCount = $Goal.Count
    constraintCount = $Constraint.Count
    decisionCount = $Decision.Count
    todoCount = $Todo.Count
    doneCount = $Done.Count
    artifactCount = $Artifact.Count
    flushAfter = [bool]$FlushAfter
    compactAfter = [bool]$CompactAfter
}

Push-Location $GovernorDir
try {
    node .\dist\src\cli.js append `
        --session $sessionId `
        --memoryDir $workspaceMemoryDir `
        --role $Role `
        --content $content | Out-Host

    if ($FlushAfter) {
        node .\dist\src\cli.js flush --session $sessionId --memoryDir $workspaceMemoryDir | Out-Host
    }

    if ($CompactAfter) {
        node .\dist\src\cli.js compact --session $sessionId --memoryDir $workspaceMemoryDir | Out-Host
    }
}
finally {
    Pop-Location
}
