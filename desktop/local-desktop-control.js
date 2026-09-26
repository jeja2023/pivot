'use strict';

const { spawn } = require('child_process');
const { isLocalDesktopControlTool, normalizeDesktopControlTask } = require('../server/services/local-desktop-control-tools');

const MAX_DESKTOP_CONTROL_OUTPUT_BYTES = 2 * 1024 * 1024;

const WINDOWS_ACCESSIBILITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type @'
using System;
using System.Runtime.InteropServices;
  public static class PivotDesktopControl { [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; } [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect); [DllImport("user32.dll", SetLastError=true)] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags); }
'@
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PIVOT_DESKTOP_CONTROL_REQUEST)) | ConvertFrom-Json
$handle = [PivotDesktopControl]::GetForegroundWindow()
if ($handle -eq [IntPtr]::Zero) { throw '未检测到前台桌面窗口。' }
$window = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
if ($null -eq $window) { throw '无法读取前台窗口的可访问性信息。' }
$title = [string]$window.Current.Name
$process = Get-Process -Id $window.Current.ProcessId -ErrorAction Stop
if (![string]::Equals($title, [string]$request.grant.windowTitle, [System.StringComparison]::OrdinalIgnoreCase)) { throw '当前前台窗口与授权窗口不匹配。' }
if ($process.ProcessName -ne ([string]$request.grant.processName).Replace('.exe','')) { throw '当前前台进程与授权应用不匹配。' }
function Find-Control($root, $target) {
  $conditions = New-Object System.Collections.Generic.List[System.Windows.Automation.Condition]
  if ($target.automationId) { $conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, [string]$target.automationId))) }
  if ($target.name) { $conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, [string]$target.name))) }
  if ($conditions.Count -eq 0) { throw '缺少可访问性目标。' }
  $condition = if ($conditions.Count -eq 1) { $conditions[0] } else { New-Object System.Windows.Automation.AndCondition($conditions.ToArray()) }
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}
if ($request.action -eq 'desktop.inspect') {
  $all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $items = @()
  foreach ($item in $all) {
    if ($items.Count -ge [int]$request.limit) { break }
    $name = [string]$item.Current.Name
    $id = [string]$item.Current.AutomationId
    if (!$name -and !$id) { continue }
    $controlType = [string]$item.Current.ControlType.ProgrammaticName
    $isEditable = $controlType -eq 'ControlType.Edit'
    $isPassword = [bool]$item.Current.IsPassword
    $items += [PSCustomObject]@{ name=if ($isEditable -or $isPassword) { '' } else { $name.Substring(0, [Math]::Min($name.Length, 240)) }; automationId=$id.Substring(0, [Math]::Min($id.Length, 240)); controlType=$controlType; enabled=[bool]$item.Current.IsEnabled; offscreen=[bool]$item.Current.IsOffscreen; editable=$isEditable; password=$isPassword }
  }
  [PSCustomObject]@{ ok=$true; result=[PSCustomObject]@{ action='desktop.inspect'; windowTitle=$title; processName=$process.ProcessName; controls=$items } } | ConvertTo-Json -Depth 6 -Compress
  exit 0
}
if ($request.action -eq 'desktop.screenshot') {
  Add-Type -AssemblyName System.Drawing
  if ([PivotDesktopControl]::GetForegroundWindow() -ne $handle) { throw '截图前授权窗口已不再处于前台。' }
  $rect = New-Object PivotDesktopControl+RECT
  if (![PivotDesktopControl]::GetWindowRect($handle, [ref]$rect)) { throw '无法读取前台窗口尺寸。' }
  $width = [Math]::Max(1, $rect.Right - $rect.Left); $height = [Math]::Max(1, $rect.Bottom - $rect.Top)
  $source = New-Object System.Drawing.Bitmap($width, $height)
  $sourceGraphics = [System.Drawing.Graphics]::FromImage($source); $hdc = $sourceGraphics.GetHdc()
  try { if (![PivotDesktopControl]::PrintWindow($handle, $hdc, [uint32]2)) { throw '无法渲染当前授权窗口。' } } finally { $sourceGraphics.ReleaseHdc($hdc); $sourceGraphics.Dispose() }
  if ([PivotDesktopControl]::GetForegroundWindow() -ne $handle) { $source.Dispose(); throw '截图期间授权窗口已失去前台状态。' }
  $ratio = [Math]::Min(1.0, [Math]::Min(1440.0 / $width, 900.0 / $height)); $outWidth = [Math]::Max(1, [int]($width * $ratio)); $outHeight = [Math]::Max(1, [int]($height * $ratio))
  $image = New-Object System.Drawing.Bitmap($outWidth, $outHeight); $graphics = [System.Drawing.Graphics]::FromImage($image); $graphics.DrawImage($source, 0, 0, $outWidth, $outHeight)
  $stream = New-Object System.IO.MemoryStream; $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }; $params = New-Object System.Drawing.Imaging.EncoderParameters(1); $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]70); $image.Save($stream, $codec, $params); $bytes = $stream.ToArray()
  $graphics.Dispose(); $image.Dispose(); $source.Dispose(); $stream.Dispose()
  if ($bytes.Length -gt 1048576) { throw '桌面应用截图超过 1 MB 安全上限。' }
  $digest = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-','').ToLowerInvariant()
  [PSCustomObject]@{ ok=$true; result=[PSCustomObject]@{ action='desktop.screenshot'; screenshot=[PSCustomObject]@{ mimeType='image/jpeg'; sha256=$digest; dataBase64=[Convert]::ToBase64String($bytes) } } } | ConvertTo-Json -Depth 7 -Compress
  exit 0
}
if ($request.action -eq 'desktop.wait') {
  $deadline = [DateTime]::UtcNow.AddMilliseconds([int]$request.timeoutMs)
  do {
    if ([PivotDesktopControl]::GetForegroundWindow() -ne $handle) { throw '等待期间授权窗口已不再处于前台。' }
    $target = Find-Control $window $request.target
    if ($null -ne $target -and $target.Current.IsEnabled -and !$target.Current.IsOffscreen) { [PSCustomObject]@{ ok=$true; result=[PSCustomObject]@{ action='desktop.wait'; found=$true } } | ConvertTo-Json -Depth 5 -Compress; exit 0 }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw '等待授权窗口控件超时。'
}
$target = Find-Control $window $request.target
if ($null -eq $target) { throw '未在当前授权窗口中找到目标控件。' }
if ([PivotDesktopControl]::GetForegroundWindow() -ne $handle) { throw '操作前授权窗口已不再处于前台。' }
if (!$target.Current.IsEnabled -or $target.Current.IsOffscreen) { throw '目标控件当前不可交互。' }
if ($request.action -eq 'desktop.click') {
  $pattern = $null
  if (!$target.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { throw '目标控件不支持可访问性 Invoke 操作。' }
  ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
  [PSCustomObject]@{ ok=$true; result=[PSCustomObject]@{ action='desktop.click'; invoked=$true } } | ConvertTo-Json -Depth 5 -Compress
  exit 0
}
if ($request.action -eq 'desktop.type') {
  if ($target.Current.IsPassword) { throw '禁止向密码字段输入或读取内容。' }
  if ($target.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit) { throw '仅允许向可访问性编辑字段输入文本。' }
  $pattern = $null
  if (!$target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { throw '目标控件不支持可访问性 Value 操作。' }
  if (([System.Windows.Automation.ValuePattern]$pattern).Current.IsReadOnly) { throw '目标编辑字段为只读。' }
  ([System.Windows.Automation.ValuePattern]$pattern).SetValue([string]$request.text)
  [PSCustomObject]@{ ok=$true; result=[PSCustomObject]@{ action='desktop.type'; chars=([string]$request.text).Length } } | ConvertTo-Json -Depth 5 -Compress
  exit 0
}
throw '未知桌面控制操作。'
`;

function desktopControlExecutionError(message, code = 'LOCAL_DESKTOP_CONTROL_EXECUTION_FAILED', status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    error.statusCode = status;
    return error;
}

function isNativeDesktopControlAvailable(platform = process.platform) { return platform === 'win32'; }

function desktopControlEnvironment(request) {
    const environment = {
        SystemRoot: process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
        WINDIR: process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows',
        PATH: process.env.PATH || '',
        PIVOT_DESKTOP_CONTROL_REQUEST: Buffer.from(JSON.stringify(request), 'utf8').toString('base64')
    };
    return environment;
}

function runPowerShell(script, request, { spawnProcess = spawn, timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
        const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
        const child = spawnProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: desktopControlEnvironment(request)
        });
        const stdout = [], stderr = [];
        let outputBytes = 0;
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            error ? reject(error) : resolve(value);
        };
        const append = (target, chunk) => {
            const buffer = Buffer.from(chunk);
            outputBytes += buffer.length;
            if (outputBytes > MAX_DESKTOP_CONTROL_OUTPUT_BYTES) {
                try { child.kill('SIGKILL'); } catch (_) {}
                finish(desktopControlExecutionError('Windows 可访问性驱动输出超过安全上限。', 'LOCAL_DESKTOP_CONTROL_OUTPUT_LIMIT', 413));
                return;
            }
            target.push(buffer);
        };
        child.stdout.on('data', chunk => append(stdout, chunk));
        child.stderr.on('data', chunk => append(stderr, chunk));
        child.on('error', error => finish(desktopControlExecutionError(`无法启动 Windows 可访问性驱动：${error.message}`, 'LOCAL_DESKTOP_CONTROL_DRIVER_UNAVAILABLE', 503)));
        child.on('close', code => {
            const output = Buffer.concat(stdout).toString('utf8').trim();
            if (code !== 0) return finish(desktopControlExecutionError(Buffer.concat(stderr).toString('utf8').trim() || 'Windows 可访问性驱动执行失败。', 'LOCAL_DESKTOP_CONTROL_DRIVER_FAILED', 502));
            try { finish(null, JSON.parse(output.split(/\r?\n/).filter(Boolean).at(-1) || '{}')); }
            catch (_) { finish(desktopControlExecutionError('Windows 可访问性驱动返回格式无效。', 'LOCAL_DESKTOP_CONTROL_OUTPUT_INVALID', 502)); }
        });
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) {}
            finish(desktopControlExecutionError('Windows 可访问性操作超时。', 'LOCAL_DESKTOP_CONTROL_TIMEOUT', 504));
        }, Math.min(Math.max(Number(timeoutMs) || 30000, 100), 30000));
    });
}

async function runLocalDesktopControlTask({ toolName, input, grant, confirmAction, platform = process.platform, runner = runPowerShell } = {}) {
    if (!isLocalDesktopControlTool(toolName)) throw desktopControlExecutionError('不支持的原生桌面控制工具。', 'LOCAL_DESKTOP_CONTROL_TOOL_INVALID');
    if (!isNativeDesktopControlAvailable(platform)) throw desktopControlExecutionError('当前平台没有已认证的原生桌面可访问性驱动。', 'LOCAL_DESKTOP_CONTROL_UNAVAILABLE', 503);
    const task = normalizeDesktopControlTask(toolName, input, grant);
    if (typeof confirmAction !== 'function') throw desktopControlExecutionError('原生桌面控制缺少本机确认通道。', 'LOCAL_DESKTOP_CONTROL_CONFIRMATION_UNAVAILABLE', 409);
    if (await confirmAction({ kind: task.action, title: '确认原生桌面应用操作', message: `将对当前前台授权应用执行 ${task.action}。`, application: task.grant.label, target: task.target || null }) !== true) {
        throw desktopControlExecutionError('用户取消了原生桌面应用操作。', 'LOCAL_DESKTOP_CONTROL_USER_CANCELLED', 409);
    }
    const result = await runner(WINDOWS_ACCESSIBILITY_SCRIPT, task, { timeoutMs: task.timeoutMs });
    if (result?.ok !== true) throw desktopControlExecutionError(result?.error?.message || '原生桌面可访问性驱动失败。', result?.error?.code || 'LOCAL_DESKTOP_CONTROL_DRIVER_FAILED', 502);
    return result.result;
}

module.exports = { MAX_DESKTOP_CONTROL_OUTPUT_BYTES, WINDOWS_ACCESSIBILITY_SCRIPT, desktopControlEnvironment, desktopControlExecutionError, isNativeDesktopControlAvailable, runLocalDesktopControlTask, runPowerShell };
