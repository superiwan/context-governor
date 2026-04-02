param(
    [Parameter(Mandatory = $true)]
    [string]$WorkspacePath,

    [string]$GovernorDir = "D:\ai_project\context-governor",

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

$resolvedWorkspace = [System.IO.Path]::GetFullPath($WorkspacePath)
$workspaceKey = $resolvedWorkspace.ToLowerInvariant()
$resolvedThreadId = $ThreadId
if ([string]::IsNullOrWhiteSpace($resolvedThreadId)) {
    $resolvedThreadId = $env:CODEX_THREAD_ID
}
$mappingPath = Join-Path $MemoryDir "workspace-sessions.json"
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
    Append-EventLog -MemoryDir $MemoryDir -SessionId $sessionId -WorkspacePath $resolvedWorkspace -ThreadId $resolvedThreadId -EventType "resume"
    node .\dist\src\cli.js resume --session $sessionId --memoryDir $MemoryDir
}
finally {
    Pop-Location
}
