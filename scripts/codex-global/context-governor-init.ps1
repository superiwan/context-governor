param(
    [Parameter(Mandatory = $true)]
    [string]$WorkspacePath,

    [string]$TaskName = "general-task",

    [string]$GovernorDir = "C:\Users\prohibit\.codex\tools\context-governor",

    [string]$MemoryDir = "C:\Users\prohibit\.codex\memories\context-governor",

    [string]$ThreadId = "",

    [switch]$ForceNew
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\context-governor-common.ps1"

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
$workspaceMemoryDir = Ensure-WorkspaceMemoryDir -MemoryRoot $MemoryDir -WorkspacePath $resolvedWorkspace
$resolvedThreadId = $ThreadId
if ([string]::IsNullOrWhiteSpace($resolvedThreadId)) {
    $resolvedThreadId = $env:CODEX_THREAD_ID
}
$mappingPath = Join-Path $workspaceMemoryDir "workspace-sessions.json"
$lockPath = Join-Path $workspaceMemoryDir ".workspace-sessions.lock"
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

Push-Location $GovernorDir
try {
    npm run build | Out-Host

    $instructions = @{
        workflow = "先搜索真实上下文，再回答；信息不全时优先读取 state 和 resume。"
        handoff  = "切换子任务、准备结束、长输出前，先 flush；必要时 compact。"
        memory   = "只持久化已确认的 goal、constraint、decision、todo、artifact，不写猜测。"
        output   = "输出简洁，优先状态、原因、修复、下一步。"
    }

    $instructionsPath = Join-Path $workspaceMemoryDir "$sessionId-instructions.json"
    Write-JsonFile -Path $instructionsPath -Value $instructions

    node .\dist\src\cli.js init `
        --session $sessionId `
        --memoryDir $workspaceMemoryDir `
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

Append-EventLog -MemoryDir $workspaceMemoryDir -SessionId $sessionId -WorkspacePath $resolvedWorkspace -ThreadId $resolvedThreadId -EventType "init" -Data @{
    taskName = $TaskName
    forceNew = [bool]$ForceNew
    reused = $reuseSession
}

$sessionDir = Join-Path $workspaceMemoryDir $sessionId
$briefPath = Join-Path $sessionDir "workspace-brief.md"
$brief = @"
# Context Governor Session

- workspace: $resolvedWorkspace
- sessionId: $sessionId
- task: $TaskName
- memoryDir: $workspaceMemoryDir

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
    memoryRootDir = [System.IO.Path]::GetFullPath($MemoryDir)
    memoryDir = $workspaceMemoryDir
    workspaceMemoryDir = $workspaceMemoryDir
    briefPath = $briefPath
}

$result | ConvertTo-Json -Depth 6
