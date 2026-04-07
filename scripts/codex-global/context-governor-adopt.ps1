param(
    [Parameter(Mandatory = $true)]
    [string]$WorkspacePath,

    [string]$SourceSessionId = "",

    [string]$SourceThreadId = "",

    [string]$GovernorDir = "C:\Users\prohibit\.codex\tools\context-governor",

    [string]$MemoryDir = "C:\Users\prohibit\.codex\memories\context-governor",

    [string]$ThreadId = ""
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\context-governor-common.ps1"

function Resolve-RecentActiveSessionId {
    param(
        [string]$MemoryDir,
        [string]$WorkspacePath,
        [string]$CurrentThreadId
    )

    $eventPath = Join-Path $MemoryDir "events.jsonl"
    if (-not (Test-Path $eventPath)) {
        return ""
    }

    $activeEvents = @("checkpoint", "flush", "compact", "resume", "init")
    $lines = Get-Content -LiteralPath $eventPath -Encoding UTF8
    [array]::Reverse($lines)

    foreach ($line in $lines) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        try {
            $parsed = ConvertTo-Hashtable ($line | ConvertFrom-Json)
        } catch {
            continue
        }

        if ($parsed["workspacePath"] -ne $WorkspacePath) {
            continue
        }

        if (-not $activeEvents.Contains([string]$parsed["eventType"])) {
            continue
        }

        $eventThreadId = [string]$parsed["threadId"]
        $eventSessionId = [string]$parsed["sessionId"]

        if ([string]::IsNullOrWhiteSpace($eventSessionId)) {
            continue
        }

        if (-not [string]::IsNullOrWhiteSpace($CurrentThreadId) -and $eventThreadId -eq $CurrentThreadId) {
            continue
        }

        return $eventSessionId
    }

    return ""
}

$resolvedWorkspace = [System.IO.Path]::GetFullPath($WorkspacePath)
$workspaceKey = $resolvedWorkspace.ToLowerInvariant()
$workspaceMemoryDir = Ensure-WorkspaceMemoryDir -MemoryRoot $MemoryDir -WorkspacePath $resolvedWorkspace
$resolvedThreadId = $ThreadId
if ([string]::IsNullOrWhiteSpace($resolvedThreadId)) {
    $resolvedThreadId = $env:CODEX_THREAD_ID
}

if ([string]::IsNullOrWhiteSpace($resolvedThreadId)) {
    throw "Adopt requires a target thread id. CODEX_THREAD_ID is empty."
}

$mappingPath = Join-Path $workspaceMemoryDir "workspace-sessions.json"
$lockPath = Join-Path $workspaceMemoryDir ".workspace-sessions.lock"
$mappings = Read-JsonFile -Path $mappingPath -Fallback @{}

if (-not $mappings.ContainsKey($workspaceKey)) {
    throw "No session mapping found for workspace: $resolvedWorkspace"
}

$workspaceEntry = $mappings[$workspaceKey]
if (-not $workspaceEntry.ContainsKey("threads")) {
    $workspaceEntry["threads"] = @{}
}

$resolvedSourceSessionId = $SourceSessionId
if ([string]::IsNullOrWhiteSpace($resolvedSourceSessionId)) {
    if (-not [string]::IsNullOrWhiteSpace($SourceThreadId) -and $workspaceEntry["threads"].ContainsKey($SourceThreadId)) {
        $resolvedSourceSessionId = $workspaceEntry["threads"][$SourceThreadId]["sessionId"]
    } elseif (-not [string]::IsNullOrWhiteSpace($resolvedThreadId) -and $workspaceEntry["threads"].ContainsKey($resolvedThreadId)) {
        $resolvedSourceSessionId = $workspaceEntry["threads"][$resolvedThreadId]["sessionId"]
    } else {
        $resolvedSourceSessionId = Resolve-RecentActiveSessionId -MemoryDir $workspaceMemoryDir -WorkspacePath $resolvedWorkspace -CurrentThreadId $resolvedThreadId
    }

    if ([string]::IsNullOrWhiteSpace($resolvedSourceSessionId)) {
        if ($workspaceEntry.ContainsKey("latestSessionId")) {
            $resolvedSourceSessionId = $workspaceEntry["latestSessionId"]
        } elseif ($workspaceEntry.ContainsKey("sessionId")) {
            $resolvedSourceSessionId = $workspaceEntry["sessionId"]
        }
    }
}

if ([string]::IsNullOrWhiteSpace($resolvedSourceSessionId)) {
    throw "Could not resolve source session to adopt."
}

$sourceDir = Join-Path $workspaceMemoryDir $resolvedSourceSessionId
if (-not (Test-Path $sourceDir)) {
    throw "Source session directory not found: $sourceDir"
}

Invoke-WithFileLock -LockPath $lockPath -Action {
    $lockedMappings = Read-JsonFile -Path $mappingPath -Fallback @{}
    $lockedWorkspaceEntry = $lockedMappings[$workspaceKey]
    if (-not $lockedWorkspaceEntry.ContainsKey("threads")) {
        $lockedWorkspaceEntry["threads"] = @{}
    }

    $lockedWorkspaceEntry["threads"][$resolvedThreadId] = @{
        sessionId = $resolvedSourceSessionId
        updatedAt = (Get-Date).ToString("s")
        adopted = $true
    }
    $lockedWorkspaceEntry["latestSessionId"] = $resolvedSourceSessionId
    $lockedWorkspaceEntry["workspacePath"] = $resolvedWorkspace
    $lockedWorkspaceEntry["updatedAt"] = (Get-Date).ToString("s")
    $lockedMappings[$workspaceKey] = $lockedWorkspaceEntry
    Write-JsonFile -Path $mappingPath -Value $lockedMappings
}

Append-EventLog -MemoryDir $workspaceMemoryDir -SessionId $resolvedSourceSessionId -WorkspacePath $resolvedWorkspace -ThreadId $resolvedThreadId -EventType "adopt" -Data @{
    sourceSessionId = $resolvedSourceSessionId
    sourceThreadId = $SourceThreadId
    autoSelected = [string]::IsNullOrWhiteSpace($SourceSessionId) -and [string]::IsNullOrWhiteSpace($SourceThreadId)
}

Push-Location $GovernorDir
try {
    node .\dist\src\cli.js resume --session $resolvedSourceSessionId --memoryDir $workspaceMemoryDir
}
finally {
    Pop-Location
}
