param(
    [Parameter(Mandatory = $true)]
    [string]$WorkspacePath,

    [string]$TaskName = "general-task",

    [string]$GovernorDir = "D:\ai_project\context-governor",

    [string]$MemoryDir = "C:\Users\prohibit\.codex\memories\context-governor",

    [string]$ThreadId = "",

    [switch]$ForceNew
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

function New-SessionId {
    param([string]$TaskName)

    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $slug = ($TaskName.ToLowerInvariant() -replace "[^a-z0-9]+", "-").Trim("-")
    if ([string]::IsNullOrWhiteSpace($slug)) {
        $slug = "session"
    }
    return "$timestamp-$slug"
}

$resolvedWorkspace = [System.IO.Path]::GetFullPath($WorkspacePath)
$workspaceKey = $resolvedWorkspace.ToLowerInvariant()
$resolvedThreadId = $ThreadId
if ([string]::IsNullOrWhiteSpace($resolvedThreadId)) {
    $resolvedThreadId = $env:CODEX_THREAD_ID
}
$mappingPath = Join-Path $MemoryDir "workspace-sessions.json"
$lockPath = Join-Path $MemoryDir ".workspace-sessions.lock"
$reuseSession = $false
$sessionId = ""

Invoke-WithFileLock -LockPath $lockPath -Action {
    $mappings = Read-JsonFile -Path $mappingPath -Fallback @{}

    $workspaceEntry = @{}
    if ($mappings.ContainsKey($workspaceKey)) {
        $workspaceEntry = $mappings[$workspaceKey]
    }

    if (-not $workspaceEntry.ContainsKey("threads")) {
        $workspaceEntry["threads"] = @{}
    }

    if (-not $ForceNew) {
        if (-not [string]::IsNullOrWhiteSpace($resolvedThreadId) -and $workspaceEntry["threads"].ContainsKey($resolvedThreadId)) {
            $script:sessionId = $workspaceEntry["threads"][$resolvedThreadId]["sessionId"]
            $script:reuseSession = $true
        } elseif ($workspaceEntry.ContainsKey("latestSessionId")) {
            $script:sessionId = $workspaceEntry["latestSessionId"]
            $script:reuseSession = $true
        }
    }

    if (-not $script:reuseSession) {
        $script:sessionId = New-SessionId -TaskName $TaskName
    }

    $workspaceEntry["latestSessionId"] = $script:sessionId
    $workspaceEntry["workspacePath"] = $resolvedWorkspace
    $workspaceEntry["updatedAt"] = (Get-Date).ToString("s")
    if (-not [string]::IsNullOrWhiteSpace($resolvedThreadId)) {
        $workspaceEntry["threads"][$resolvedThreadId] = @{
            sessionId = $script:sessionId
            updatedAt = (Get-Date).ToString("s")
        }
    }

    $mappings[$workspaceKey] = $workspaceEntry
    Write-JsonFile -Path $mappingPath -Value $mappings
}

if (-not (Test-Path $GovernorDir)) {
    throw "Governor directory not found: $GovernorDir"
}

if (-not (Test-Path $MemoryDir)) {
    New-Item -ItemType Directory -Path $MemoryDir | Out-Null
}

Push-Location $GovernorDir
try {
    npm run build | Out-Host

    $instructions = @{
        workflow = "先搜索真实上下文，再回答；信息不全时优先读取 state 和 resume。"
        handoff  = "切换子任务、准备结束、长输出前，先 flush；必要时 compact。"
        memory   = "只持久化已确认的 goal、constraint、decision、todo、artifact，不写猜测。"
        output   = "输出简洁，优先状态、原因、修复、下一步。"
    }

    $instructionsPath = Join-Path $MemoryDir "$sessionId-instructions.json"
    Write-JsonFile -Path $instructionsPath -Value $instructions

    node .\dist\src\cli.js init `
        --session $sessionId `
        --memoryDir $MemoryDir `
        --sectionsFile $instructionsPath `
        --recentTurnsPreserve 5 `
        --softThresholdTokens 4000 `
        --maxContextTokens 24000 `
        --compactionTriggerTokens 22000 `
        --postCompactionSections workflow,handoff,memory,output | Out-Host
}
finally {
    Pop-Location
}

Append-EventLog -MemoryDir $MemoryDir -SessionId $sessionId -WorkspacePath $resolvedWorkspace -ThreadId $resolvedThreadId -EventType "init" -Data @{
    taskName = $TaskName
    forceNew = [bool]$ForceNew
    reused = $reuseSession
}

$sessionDir = Join-Path $MemoryDir $sessionId
$briefPath = Join-Path $sessionDir "workspace-brief.md"
$brief = @"
# Context Governor Session

- workspace: $resolvedWorkspace
- sessionId: $sessionId
- task: $TaskName
- memoryDir: $MemoryDir

## Agent workflow

- 长任务开始先 resume
- 阶段完成后 flush
- 切换子任务、上下文变长、准备交接前 compact
- 不确定当前状态时，先读 state.json 和 recent resume
"@
Set-Content -LiteralPath $briefPath -Value $brief -Encoding UTF8

$result = @{
    ok = $true
    workspacePath = $resolvedWorkspace
    sessionId = $sessionId
    threadId = $resolvedThreadId
    memoryDir = $MemoryDir
    briefPath = $briefPath
}

$result | ConvertTo-Json -Depth 6
