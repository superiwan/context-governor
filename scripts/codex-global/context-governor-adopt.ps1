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

function Read-JsonFile {
    param(
        [string]$Path,
        $Fallback
    )

    if (-not (Test-Path $Path)) {
        return $Fallback
    }

    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return $Fallback
    }

    $parsed = $raw | ConvertFrom-Json
    return ConvertTo-Hashtable $parsed
}

function ConvertTo-Hashtable {
    param($Value)

    if ($null -eq $Value) {
        return $null
    }

    if ($Value -is [System.Collections.IDictionary]) {
        $table = @{}
        foreach ($key in $Value.Keys) {
            $table[$key] = ConvertTo-Hashtable $Value[$key]
        }
        return $table
    }

    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
        $items = @()
        foreach ($item in $Value) {
            $items += @(ConvertTo-Hashtable $item)
        }
        return $items
    }

    if ($Value -is [pscustomobject]) {
        $table = @{}
        foreach ($prop in $Value.PSObject.Properties) {
            $table[$prop.Name] = ConvertTo-Hashtable $prop.Value
        }
        return $table
    }

    return $Value
}

function Write-JsonFile {
    param(
        [string]$Path,
        $Value
    )

    $dir = Split-Path -Parent $Path
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }

    $json = $Value | ConvertTo-Json -Depth 10
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

function Append-EventLog {
    param(
        [string]$MemoryDir,
        [string]$SessionId,
        [string]$WorkspacePath,
        [string]$EventType,
        [string]$ThreadId = "",
        [hashtable]$Data = @{}
    )

    $eventPath = Join-Path $MemoryDir "events.jsonl"
    $event = @{
        timestamp = (Get-Date).ToString("o")
        eventType = $EventType
        sessionId = $SessionId
        workspacePath = $WorkspacePath
        threadId = $ThreadId
        data = $Data
    }
    Add-Content -LiteralPath $eventPath -Value (($event | ConvertTo-Json -Compress) + [Environment]::NewLine) -Encoding UTF8
}

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

function Invoke-WithFileLock {
    param(
        [string]$LockPath,
        [scriptblock]$Action
    )

    $acquired = $false
    try {
        for ($i = 0; $i -lt 100; $i++) {
            try {
                New-Item -ItemType Directory -Path $LockPath -ErrorAction Stop | Out-Null
                $acquired = $true
                break
            } catch {
                Start-Sleep -Milliseconds 100
            }
        }

        if (-not $acquired) {
            throw "Failed to acquire lock: $LockPath"
        }

        & $Action
    }
    finally {
        if ($acquired -and (Test-Path $LockPath)) {
            try {
                Remove-Item -LiteralPath $LockPath -Recurse -Force -ErrorAction Stop
            } catch {
            }
        }
    }
}

$resolvedWorkspace = [System.IO.Path]::GetFullPath($WorkspacePath)
$workspaceKey = $resolvedWorkspace.ToLowerInvariant()
$resolvedThreadId = $ThreadId
if ([string]::IsNullOrWhiteSpace($resolvedThreadId)) {
    $resolvedThreadId = $env:CODEX_THREAD_ID
}

if ([string]::IsNullOrWhiteSpace($resolvedThreadId)) {
    throw "Adopt requires a target thread id. CODEX_THREAD_ID is empty."
}

$mappingPath = Join-Path $MemoryDir "workspace-sessions.json"
$lockPath = Join-Path $MemoryDir ".workspace-sessions.lock"
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
        $resolvedSourceSessionId = Resolve-RecentActiveSessionId -MemoryDir $MemoryDir -WorkspacePath $resolvedWorkspace -CurrentThreadId $resolvedThreadId
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

$sourceDir = Join-Path $MemoryDir $resolvedSourceSessionId
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

Append-EventLog -MemoryDir $MemoryDir -SessionId $resolvedSourceSessionId -WorkspacePath $resolvedWorkspace -ThreadId $resolvedThreadId -EventType "adopt" -Data @{
    sourceSessionId = $resolvedSourceSessionId
    sourceThreadId = $SourceThreadId
    autoSelected = [string]::IsNullOrWhiteSpace($SourceSessionId) -and [string]::IsNullOrWhiteSpace($SourceThreadId)
}

Push-Location $GovernorDir
try {
    node .\dist\src\cli.js resume --session $resolvedSourceSessionId --memoryDir $MemoryDir
}
finally {
    Pop-Location
}
