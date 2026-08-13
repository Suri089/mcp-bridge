param(
    [string]$InstallDirectory,
    [string[]]$Clients,
    [switch]$ConfigureAll,
    [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$proxyBuildPath = Join-Path $repoRoot 'dist\mcp-proxy.js'
$serverName = 'mcp-bridge'

function Resolve-UserPath {
    param([string]$PathValue)
    $expanded = [Environment]::ExpandEnvironmentVariables($PathValue.Trim().Trim('"'))
    if ($expanded.StartsWith('~')) {
        $expanded = Join-Path $HOME $expanded.Substring(1).TrimStart('\', '/')
    }
    return [System.IO.Path]::GetFullPath($expanded)
}

function Backup-Config {
    param([string]$ConfigPath)
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        return $null
    }
    $backupPath = "$ConfigPath.mcp-bridge.$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
    Copy-Item -LiteralPath $ConfigPath -Destination $backupPath -Force
    return $backupPath
}

function Set-ObjectProperty {
    param($Object, [string]$Name, $Value)
    $property = $Object.PSObject.Properties[$Name]
    if ($property) {
        $property.Value = $Value
    } else {
        $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
    }
}

function Update-JsonConfig {
    param([string]$ConfigPath, [string]$RootKey, [string]$ProxyPath)
    New-Item -ItemType Directory -Path (Split-Path -Parent $ConfigPath) -Force | Out-Null
    $backupPath = Backup-Config -ConfigPath $ConfigPath
    if (Test-Path -LiteralPath $ConfigPath) {
        try {
            $data = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        } catch {
            throw "Invalid JSON; the file was not modified: $ConfigPath"
        }
    } else {
        $data = [pscustomobject]@{}
    }

    $rootProperty = $data.PSObject.Properties[$RootKey]
    if (-not $rootProperty -or $null -eq $rootProperty.Value) {
        $root = [pscustomobject]@{}
        Set-ObjectProperty -Object $data -Name $RootKey -Value $root
    } else {
        $root = $rootProperty.Value
    }
    $serverConfig = [pscustomobject]@{ command = 'node'; args = @($ProxyPath.Replace('\', '/')) }
    Set-ObjectProperty -Object $root -Name $serverName -Value $serverConfig
    $json = $data | ConvertTo-Json -Depth 100
    [System.IO.File]::WriteAllText($ConfigPath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
    return $backupPath
}

function Update-CodexConfig {
    param([string]$ConfigPath, [string]$ProxyPath)
    New-Item -ItemType Directory -Path (Split-Path -Parent $ConfigPath) -Force | Out-Null
    $backupPath = Backup-Config -ConfigPath $ConfigPath
    $content = if (Test-Path -LiteralPath $ConfigPath) { Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 } else { '' }
    $normalizedProxyPath = $ProxyPath.Replace('\', '/')
    $section = @"
[mcp_servers.mcp-bridge]
command = "node"
args = ["$normalizedProxyPath"]
startup_timeout_sec = 15
tool_timeout_sec = 120
"@
    $pattern = '(?ms)^\[mcp_servers\.mcp-bridge\]\r?\n.*?(?=^\[|\z)'
    if ([regex]::IsMatch($content, $pattern)) {
        $updated = [regex]::Replace($content, $pattern, $section.TrimEnd() + [Environment]::NewLine)
    } else {
        $separator = if ($content.Length -eq 0) { '' } elseif ($content.EndsWith("`n")) { "`n" } else { "`r`n`r`n" }
        $updated = $content + $separator + $section.Trim() + [Environment]::NewLine
    }
    [System.IO.File]::WriteAllText($ConfigPath, $updated, (New-Object System.Text.UTF8Encoding($false)))
    return $backupPath
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js was not found in PATH.'
}
if (-not $InstallDirectory) {
    $defaultDirectory = Join-Path $HOME '.mcp-bridge'
    $inputDirectory = Read-Host "Proxy install directory [$defaultDirectory]"
    $InstallDirectory = if ($inputDirectory) { $inputDirectory } else { $defaultDirectory }
}
$InstallDirectory = Resolve-UserPath -PathValue $InstallDirectory

if (-not $SkipBuild) {
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw 'npm.cmd was not found in PATH.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules'))) {
        & npm.cmd install --prefix $repoRoot
        if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
    }
    & npm.cmd run build --prefix $repoRoot
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }
}
if (-not (Test-Path -LiteralPath $proxyBuildPath)) {
    throw "Built proxy was not found: $proxyBuildPath"
}

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
$installedProxyPath = Join-Path $InstallDirectory 'mcp-proxy.js'
Copy-Item -LiteralPath $proxyBuildPath -Destination $installedProxyPath -Force

$appDataDirectory = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $HOME 'AppData\Roaming' }
$targets = @(
    [pscustomobject]@{ Name = 'Antigravity'; Path = Join-Path $HOME '.gemini\config\mcp_config.json'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'Cherry Studio'; Path = Join-Path $appDataDirectory 'cherry-studio\mcp.json'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'Claude Code'; Path = Join-Path $HOME '.claude.json'; DetectPath = Join-Path $HOME '.claude'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'Claude Desktop'; Path = Join-Path $appDataDirectory 'Claude\claude_desktop_config.json'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'Cline'; Path = Join-Path $appDataDirectory 'Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'CodeBuddy CLI'; Path = Join-Path $HOME '.codebuddy\mcp.json'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'CodeWhale'; Path = Join-Path $HOME '.codewhale\mcp.json'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'Deepseek-TUI'; Path = Join-Path $HOME '.deepseek\mcp.json'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'Codex'; Path = Join-Path $HOME '.codex\config.toml'; DetectPath = Join-Path $HOME '.codex'; Format = 'toml'; RootKey = '' },
    [pscustomobject]@{ Name = 'Cursor'; Path = Join-Path $HOME '.cursor\mcp.json'; DetectPath = Join-Path $HOME '.cursor'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'Gemini CLI'; Path = Join-Path $HOME '.gemini\mcp.json'; DetectPath = Join-Path $HOME '.gemini'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'GitHub Copilot CLI'; Path = Join-Path $HOME '.config\github-copilot\mcp.json'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'Kilo Code'; Path = Join-Path $HOME '.kilo\mcp.json'; DetectPath = Join-Path $HOME '.kilo'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'Kiro'; Path = Join-Path $HOME '.kiro\mcp.json'; DetectPath = Join-Path $HOME '.kiro'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'OpenCode'; Path = Join-Path $HOME '.opencode\mcp.json'; DetectPath = Join-Path $HOME '.opencode'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'Qwen Code'; Path = Join-Path $HOME '.qwen\mcp.json'; DetectPath = Join-Path $HOME '.qwen'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'Rider GitHub Copilot'; Path = Join-Path $appDataDirectory 'JetBrains\Rider\github-copilot\mcp.json'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'Roo Code'; Path = Join-Path $appDataDirectory 'Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\cline_mcp_settings.json'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'Trae'; Path = Join-Path $HOME '.trae\mcp.json'; DetectPath = Join-Path $HOME '.trae'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'Trae CN'; Path = Join-Path $HOME '.trae-cn\mcp.json'; DetectPath = Join-Path $HOME '.trae-cn'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'VSCode GitHub Copilot'; Path = Join-Path $appDataDirectory 'Code\User\globalStorage\github.copilot\mcp.json'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'VSCode Insiders GitHub Copilot'; Path = Join-Path $appDataDirectory 'Code - Insiders\User\globalStorage\github.copilot\mcp.json'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'Windsurf'; Path = Join-Path $HOME '.codeium\windsurf\mcp_config.json'; Format = 'json'; RootKey = 'mcpServers' },
    [pscustomobject]@{ Name = 'Zed'; Path = Join-Path $appDataDirectory 'Zed\settings.json'; Format = 'json'; RootKey = 'context_servers' }
)

if ($Clients -and $Clients.Count -gt 0) {
    $unknownClients = $Clients | Where-Object { $_ -notin $targets.Name }
    if ($unknownClients) { throw "Unknown client name(s): $($unknownClients -join ', ')" }
    $selectedTargets = $targets | Where-Object { $Clients -contains $_.Name }
} elseif ($ConfigureAll) {
    $selectedTargets = $targets
} else {
    $selectedTargets = $targets | Where-Object {
        $detectProperty = $_.PSObject.Properties['DetectPath']
        (Test-Path -LiteralPath $_.Path) -or ($detectProperty -and (Test-Path -LiteralPath $detectProperty.Value))
    }
}

if (-not $selectedTargets) {
    Write-Warning 'No installed AI clients were detected. The proxy was installed, but no client configuration was changed.'
} else {
    foreach ($target in $selectedTargets) {
        try {
            if ($target.Format -eq 'toml') {
                $backupPath = Update-CodexConfig -ConfigPath $target.Path -ProxyPath $installedProxyPath
            } else {
                $backupPath = Update-JsonConfig -ConfigPath $target.Path -RootKey $target.RootKey -ProxyPath $installedProxyPath
            }
            $backupMessage = if ($backupPath) { " (backup: $backupPath)" } else { '' }
            Write-Host "Configured $($target.Name): $($target.Path)$backupMessage" -ForegroundColor Green
        } catch {
            Write-Warning "Failed to configure $($target.Name): $($_.Exception.Message)"
        }
    }
}

$hash = (Get-FileHash -LiteralPath $installedProxyPath -Algorithm SHA256).Hash
Write-Host "Installed proxy: $installedProxyPath" -ForegroundColor Green
Write-Host "SHA-256: $hash"
Write-Host 'Restart the configured AI clients before using the MCP server.'
