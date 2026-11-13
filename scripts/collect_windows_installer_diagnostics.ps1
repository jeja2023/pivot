param(
    [string]$InstallDirectory = '',
    [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Read-UpdatePolicy([string]$ConfigPath) {
    if (![IO.File]::Exists($ConfigPath)) { return $null }
    try {
        $config = [IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
        return [ordered]@{
            source = $ConfigPath
            mode = $config.mode
            enabled = $config.autoUpdate.enabled
            publisherName = $config.autoUpdate.publisherName
            allowUntrustedRoot = $config.autoUpdate.allowUntrustedRoot
            certificateSha256 = $config.autoUpdate.certificateSha256
        }
    } catch {
        return [ordered]@{ source = $ConfigPath; error = '无法读取客户端更新配置。' }
    }
}

$installations = [Collections.Generic.List[object]]::new()
foreach ($registryRoot in @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)) {
    if (!(Test-Path -LiteralPath $registryRoot)) { continue }
    foreach ($key in Get-ChildItem -LiteralPath $registryRoot -ErrorAction SilentlyContinue) {
        $item = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
        if ($item.DisplayName -ne 'Pivot') { continue }
        $installations.Add([ordered]@{
            displayName = $item.DisplayName
            displayVersion = $item.DisplayVersion
            installLocation = $item.InstallLocation
            registryPath = $key.Name
        })
    }
}

$processes = [Collections.Generic.List[object]]::new()
foreach ($process in [Diagnostics.Process]::GetProcesses()) {
    try {
        $name = $process.ProcessName
        if ($name -notmatch '(?i)pivot|uninstall|setup|powershell|pwsh') { continue }
        $record = [ordered]@{ pid = $process.Id; name = $name }
        try { $record.path = $process.MainModule.FileName } catch { $record.path = '无权读取进程路径' }
        try { $record.startedAt = $process.StartTime.ToString('o') } catch {}
        try { $record.cpuSeconds = $process.TotalProcessorTime.TotalSeconds } catch {}
        try { $record.windowTitle = $process.MainWindowTitle; $record.responding = $process.Responding } catch {}
        $processes.Add($record)
    } finally {
        $process.Dispose()
    }
}

$roots = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
if ($InstallDirectory) { [void]$roots.Add([IO.Path]::GetFullPath($InstallDirectory)) }
foreach ($item in $installations) {
    if ($item.installLocation) { [void]$roots.Add($item.installLocation) }
}
if ($env:LOCALAPPDATA) { [void]$roots.Add((Join-Path $env:LOCALAPPDATA 'Programs\Pivot')) }
if ($env:ProgramFiles) { [void]$roots.Add((Join-Path $env:ProgramFiles 'Pivot')) }
$files = [Collections.Generic.List[object]]::new()
$policies = [Collections.Generic.List[object]]::new()
foreach ($root in $roots) {
    foreach ($relative in @('Pivot.exe', 'Uninstall Pivot.exe', 'resources\app.asar')) {
        $file = Join-Path $root $relative
        if (![IO.File]::Exists($file)) { continue }
        $info = [IO.FileInfo]::new($file)
        $files.Add([ordered]@{ path = $file; size = $info.Length; modifiedAt = $info.LastWriteTime.ToString('o'); version = [Diagnostics.FileVersionInfo]::GetVersionInfo($file).ProductVersion })
    }
    foreach ($relative in @('config.json', 'resources\config.json')) {
        $policy = Read-UpdatePolicy (Join-Path $root $relative)
        if ($policy) { $policies.Add($policy) }
    }
}
if ($env:APPDATA) {
    $policy = Read-UpdatePolicy (Join-Path $env:APPDATA 'pivot\user-config.json')
    if ($policy) { $policies.Add($policy) }
}

$stages = [Collections.Generic.List[object]]::new()
foreach ($log in Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Filter 'PivotInstaller-*.log' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 5) {
    try {
        $stages.Add([ordered]@{ path = $log.FullName; modifiedAt = $log.LastWriteTime.ToString('o'); tail = @(Get-Content -LiteralPath $log.FullName -Encoding Unicode -Tail 8) })
    } catch {}
}

# 仅记录安装状态和更新策略白名单，不收集凭据、业务资料、完整配置或进程命令行。
$report = [ordered]@{
    collectedAt = [DateTimeOffset]::Now.ToString('o')
    windowsVersion = [Environment]::OSVersion.VersionString
    is64BitProcess = [Environment]::Is64BitProcess
    installations = @($installations.ToArray())
    processes = @($processes.ToArray())
    files = @($files.ToArray())
    updatePolicies = @($policies.ToArray())
    installerStages = @($stages.ToArray())
}
if (!$OutputPath) {
    $OutputPath = Join-Path ([IO.Path]::GetTempPath()) ('PivotInstallerDiagnostics-' + [Guid]::NewGuid().ToString('N') + '.json')
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$stream = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Depth 6))
    $stream.Write($bytes, 0, $bytes.Length)
} finally {
    $stream.Dispose()
}
[Console]::Out.WriteLine('诊断已保存：' + $OutputPath)
