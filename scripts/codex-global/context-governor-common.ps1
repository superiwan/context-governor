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

function Write-LinesFile {
    param(
        [string]$Path,
        [string[]]$Lines
    )

    $dir = Split-Path -Parent $Path
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($Path, $Lines, $utf8NoBom)
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

    if (-not (Test-Path $MemoryDir)) {
        New-Item -ItemType Directory -Path $MemoryDir | Out-Null
    }

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

function Get-WorkspaceFolderName {
    param([string]$WorkspacePath)

    $normalized = [System.IO.Path]::GetFullPath($WorkspacePath).ToLowerInvariant()
    $slug = ($normalized -replace "^[a-z]:\\", "" -replace "[^a-z0-9]+", "-").Trim("-")
    if ([string]::IsNullOrWhiteSpace($slug)) {
        $slug = "workspace"
    }

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($normalized)
        $hash = [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }

    return "$slug-$($hash.Substring(0, 8))"
}

function Get-WorkspaceMemoryDir {
    param(
        [string]$MemoryRoot,
        [string]$WorkspacePath
    )

    $resolvedRoot = [System.IO.Path]::GetFullPath($MemoryRoot)
    $workspaceFolder = Get-WorkspaceFolderName -WorkspacePath $WorkspacePath
    return Join-Path (Join-Path $resolvedRoot "workspaces") $workspaceFolder
}

function Migrate-LegacyWorkspaceMemory {
    param(
        [string]$MemoryRoot,
        [string]$WorkspacePath,
        [string]$WorkspaceDir
    )

    $workspaceKey = $WorkspacePath.ToLowerInvariant()
    $targetMappingPath = Join-Path $WorkspaceDir "workspace-sessions.json"
    if (Test-Path $targetMappingPath) {
        return
    }

    $legacyMappingPath = Join-Path $MemoryRoot "workspace-sessions.json"
    if (-not (Test-Path $legacyMappingPath)) {
        return
    }

    $legacyMappings = Read-JsonFile -Path $legacyMappingPath -Fallback @{}
    if (-not $legacyMappings.ContainsKey($workspaceKey)) {
        return
    }

    $workspaceEntry = $legacyMappings[$workspaceKey]
    Write-JsonFile -Path $targetMappingPath -Value @{
        $workspaceKey = $workspaceEntry
    }

    $legacyEventPath = Join-Path $MemoryRoot "events.jsonl"
    $targetEventPath = Join-Path $WorkspaceDir "events.jsonl"
    if ((Test-Path $legacyEventPath) -and (-not (Test-Path $targetEventPath))) {
        $matched = [System.Collections.Generic.List[string]]::new()
        foreach ($line in (Get-Content -LiteralPath $legacyEventPath -Encoding UTF8)) {
            if ([string]::IsNullOrWhiteSpace($line)) {
                continue
            }

            try {
                $parsed = ConvertTo-Hashtable ($line | ConvertFrom-Json)
            } catch {
                continue
            }

            if ([string]$parsed["workspacePath"] -eq $WorkspacePath) {
                $matched.Add($line)
            }
        }

        if ($matched.Count -gt 0) {
            Write-LinesFile -Path $targetEventPath -Lines $matched.ToArray()
        }
    }

    $sessionIds = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($field in @("latestSessionId", "sessionId")) {
        $value = [string]$workspaceEntry[$field]
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            $null = $sessionIds.Add($value)
        }
    }

    if ($workspaceEntry.ContainsKey("threads")) {
        foreach ($threadEntry in $workspaceEntry["threads"].Values) {
            $value = [string]$threadEntry["sessionId"]
            if (-not [string]::IsNullOrWhiteSpace($value)) {
                $null = $sessionIds.Add($value)
            }
        }
    }

    foreach ($sessionId in $sessionIds) {
        $sourceSessionDir = Join-Path $MemoryRoot $sessionId
        $targetSessionDir = Join-Path $WorkspaceDir $sessionId
        if ((Test-Path $sourceSessionDir) -and (-not (Test-Path $targetSessionDir))) {
            Copy-Item -LiteralPath $sourceSessionDir -Destination $targetSessionDir -Recurse
        }

        $sourceInstructions = Join-Path $MemoryRoot "$sessionId-instructions.json"
        $targetInstructions = Join-Path $WorkspaceDir "$sessionId-instructions.json"
        if ((Test-Path $sourceInstructions) -and (-not (Test-Path $targetInstructions))) {
            Copy-Item -LiteralPath $sourceInstructions -Destination $targetInstructions
        }
    }
}

function Ensure-WorkspaceMemoryDir {
    param(
        [string]$MemoryRoot,
        [string]$WorkspacePath
    )

    $resolvedRoot = [System.IO.Path]::GetFullPath($MemoryRoot)
    $workspacesDir = Join-Path $resolvedRoot "workspaces"
    $workspaceDir = Get-WorkspaceMemoryDir -MemoryRoot $resolvedRoot -WorkspacePath $WorkspacePath

    if (-not (Test-Path $resolvedRoot)) {
        New-Item -ItemType Directory -Path $resolvedRoot | Out-Null
    }

    if (-not (Test-Path $workspacesDir)) {
        New-Item -ItemType Directory -Path $workspacesDir | Out-Null
    }

    if (-not (Test-Path $workspaceDir)) {
        New-Item -ItemType Directory -Path $workspaceDir | Out-Null
    }

    Migrate-LegacyWorkspaceMemory -MemoryRoot $resolvedRoot -WorkspacePath $WorkspacePath -WorkspaceDir $workspaceDir

    $workspaceFile = Join-Path $workspaceDir "workspace.json"
    if (-not (Test-Path $workspaceFile)) {
        Write-JsonFile -Path $workspaceFile -Value @{
            workspacePath = $WorkspacePath
            workspaceKey = $WorkspacePath.ToLowerInvariant()
            workspaceFolder = Split-Path -Leaf $WorkspacePath
            updatedAt = (Get-Date).ToString("o")
        }
    }

    return $workspaceDir
}
