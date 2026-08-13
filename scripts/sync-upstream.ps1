param(
    [string]$UpstreamUrl = 'git@github.com:firekula/mcp-bridge.git',
    [string]$UpstreamBranch = 'main',
    [string]$BaseBranch = 'main',
    [switch]$SkipPushBase,
    [switch]$PushCurrentBranch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Invoke-Git {
    param([string[]]$Arguments, [switch]$Capture)
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    if ($Capture) {
        try {
            $output = & git -C $repoRoot @Arguments 2>&1
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($exitCode -ne 0) {
            throw "git $($Arguments -join ' ') failed:`n$($output -join [Environment]::NewLine)"
        }
        return @($output | Where-Object { $_ -notmatch '^warning: unable to access ' })
    }
    try {
        & git -C $repoRoot @Arguments
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) {
        throw "git $($Arguments -join ' ') failed."
    }
}

function Test-GitRef {
    param([string]$Ref)
    & git -C $repoRoot show-ref --verify --quiet $Ref
    return $LASTEXITCODE -eq 0
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git was not found in PATH.'
}

$dirty = Invoke-Git -Arguments @('status', '--porcelain') -Capture
if ($dirty) {
    throw "The worktree has uncommitted changes. Commit or stash them before syncing.`n$($dirty -join [Environment]::NewLine)"
}

$currentBranch = (Invoke-Git -Arguments @('branch', '--show-current') -Capture | Select-Object -First 1).Trim()
if (-not $currentBranch) {
    throw 'Detached HEAD is not supported. Switch to a development branch first.'
}

$configuredRemotes = Invoke-Git -Arguments @('remote') -Capture
$hasUpstream = $configuredRemotes -contains 'upstream'
if (-not $hasUpstream) {
    Invoke-Git -Arguments @('remote', 'add', 'upstream', $UpstreamUrl)
} else {
    Invoke-Git -Arguments @('remote', 'set-url', 'upstream', $UpstreamUrl)
}

Write-Host "Repository: $repoRoot"
Write-Host "Current branch: $currentBranch"

$originFetchSpec = '+refs/heads/*:refs/remotes/origin/*'
$configuredFetchSpecs = Invoke-Git -Arguments @('config', '--get-all', 'remote.origin.fetch') -Capture
if ($configuredFetchSpecs -notcontains $originFetchSpec) {
    Write-Host 'Expanding origin fetch configuration to include all branches...'
    Invoke-Git -Arguments @('config', 'remote.origin.fetch', $originFetchSpec)
}
Invoke-Git -Arguments @('fetch', 'origin', '--prune')

$isShallow = (Invoke-Git -Arguments @('rev-parse', '--is-shallow-repository') -Capture | Select-Object -First 1).Trim()
if ($isShallow -eq 'true') {
    Write-Host 'Converting the shallow clone to a complete repository...'
    Invoke-Git -Arguments @('fetch', 'origin', '--unshallow')
}

$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & git -C $repoRoot fetch origin "${BaseBranch}:refs/remotes/origin/${BaseBranch}"
    $originBaseFetchExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
}
if ($originBaseFetchExitCode -ne 0) {
    Write-Warning "origin/$BaseBranch was not found. $BaseBranch will be created from upstream/$UpstreamBranch."
}
Invoke-Git -Arguments @('fetch', 'upstream', '--prune')

$upstreamRef = "refs/remotes/upstream/$UpstreamBranch"
if (-not (Test-GitRef -Ref $upstreamRef)) {
    throw "Upstream branch was not found: upstream/$UpstreamBranch"
}

try {
    if (Test-GitRef -Ref "refs/heads/$BaseBranch") {
        Invoke-Git -Arguments @('switch', $BaseBranch)
    } elseif (Test-GitRef -Ref "refs/remotes/origin/$BaseBranch") {
        Invoke-Git -Arguments @('switch', '--track', '-c', $BaseBranch, "origin/$BaseBranch")
    } else {
        Invoke-Git -Arguments @('switch', '-c', $BaseBranch, "upstream/$UpstreamBranch")
    }

    if (Test-GitRef -Ref "refs/remotes/origin/$BaseBranch") {
        Invoke-Git -Arguments @('merge', '--ff-only', "origin/$BaseBranch")
    }
    Invoke-Git -Arguments @('merge', '--ff-only', "upstream/$UpstreamBranch")
    if (-not $SkipPushBase) {
        Invoke-Git -Arguments @('push', 'origin', $BaseBranch)
    }
} catch {
    $recoveryStatus = Invoke-Git -Arguments @('status', '--porcelain') -Capture
    if ($recoveryStatus) {
        Invoke-Git -Arguments @('restore', '--staged', '--worktree', '--source=HEAD', '--', '.')
    }
    if ($currentBranch -ne $BaseBranch) {
        $activeBranch = (Invoke-Git -Arguments @('branch', '--show-current') -Capture | Select-Object -First 1).Trim()
        if ($activeBranch -ne $currentBranch) {
            Invoke-Git -Arguments @('switch', $currentBranch)
        }
    }
    throw
}

if ($currentBranch -ne $BaseBranch) {
    Invoke-Git -Arguments @('switch', $currentBranch)
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & git -C $repoRoot merge --no-edit $BaseBranch
        $mergeExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($mergeExitCode -ne 0) {
        throw "Merge stopped on $currentBranch. Resolve and commit it, or run 'git merge --abort'."
    }
    if ($PushCurrentBranch) {
        Invoke-Git -Arguments @('push', 'origin', $currentBranch)
    }
}

Write-Host 'Sync completed successfully.' -ForegroundColor Green
Write-Host "upstream/$UpstreamBranch -> $BaseBranch -> $currentBranch"
