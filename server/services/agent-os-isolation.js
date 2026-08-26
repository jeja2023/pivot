const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const WINDOWS_JOB_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PivotJob {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job, int infoType, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
  public const uint PROCESS_ALL_ACCESS = 0x1F0FFF;
  public const int JobObjectExtendedLimitInformation = 9;
  public const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x100;
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] public struct BasicLimitInformation { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] public struct ExtendedLimitInformation { public BasicLimitInformation BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  public static IntPtr Attach(uint pid, ulong memory) {
    var job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed");
    var process = OpenProcess(PROCESS_ALL_ACCESS, false, pid); if (process == IntPtr.Zero) throw new Exception("OpenProcess failed");
    var info = new ExtendedLimitInformation(); info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY; info.ProcessMemoryLimit = (UIntPtr)memory;
    var size = Marshal.SizeOf(info); var ptr = Marshal.AllocHGlobal(size); try { Marshal.StructureToPtr(info, ptr, false); if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)size)) throw new Exception("SetInformationJobObject failed"); if (!AssignProcessToJobObject(job, process)) throw new Exception("AssignProcessToJobObject failed"); } finally { Marshal.FreeHGlobal(ptr); CloseHandle(process); }
    return job;
  }
}
'@
$targetPid = [uint32]$env:PIVOT_AGENT_TARGET_PID
$memoryBytes = [uint64]$env:PIVOT_AGENT_MEMORY_BYTES
$job = [PivotJob]::Attach($targetPid, $memoryBytes)
while (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 250 }
[PivotJob]::CloseHandle($job) | Out-Null
`;

function isolationId() { return `pivot-agent-${process.pid}-${crypto.randomBytes(4).toString('hex')}`; }

function canWriteDirectory(target) {
    try { fs.accessSync(target, fs.constants.W_OK); return true; } catch (_) { return false; }
}

function buildIsolationSpec(options = {}) {
    const memoryLimitBytes = Math.max(Number(options.memoryLimitBytes) || 512 * 1024 * 1024, 16 * 1024 * 1024);
    const strictEnv = process.env.PIVOT_AGENT_STRICT_ISOLATION;
    const strict = (strictEnv === '0' || strictEnv === 'false') ? false : (options.strictIsolation === true);
    const networkDisabled = options.networkDisabled === true;
    return {
        platform: process.platform,
        strict,
        networkDisabled,
        memoryLimitBytes,
        cgroupRoot: options.cgroupRoot || process.env.PIVOT_AGENT_CGROUP_ROOT || '/sys/fs/cgroup',
        id: isolationId()
    };
}

function createLinuxCgroup(spec) {
    if (process.platform !== 'linux') return null;
    const root = path.resolve(spec.cgroupRoot);
    if (!canWriteDirectory(root)) {
        if (spec.strict) throw Object.assign(new Error('Linux cgroup 根目录不可写，严格沙箱无法启动。'), { code: 'AGENT_CGROUP_UNAVAILABLE', category: 'resource' });
        return null;
    }
    const dir = path.join(root, spec.id);
    try {
        fs.mkdirSync(dir, { recursive: false });
        fs.writeFileSync(path.join(dir, 'memory.max'), String(spec.memoryLimitBytes));
        fs.writeFileSync(path.join(dir, 'pids.max'), '64');
        return { dir, cleanup() { try { fs.rmdirSync(dir); } catch (_) {} } };
    } catch (error) {
        if (spec.strict) throw Object.assign(new Error(`Linux cgroup 创建失败：${error.message}`), { code: 'AGENT_CGROUP_CREATE_FAILED', category: 'resource', cause: error });
        return null;
    }
}

function attachLinuxCgroup(cgroup, pid) {
    if (!cgroup) return;
    fs.writeFileSync(path.join(cgroup.dir, 'cgroup.procs'), String(pid));
}

function attachWindowsJob(pid, spec) {
    if (process.platform !== 'win32') return null;
    const encoded = Buffer.from(WINDOWS_JOB_SCRIPT, 'utf16le').toString('base64');
    const helper = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
        env: { ...process.env, PIVOT_AGENT_TARGET_PID: String(pid), PIVOT_AGENT_MEMORY_BYTES: String(spec.memoryLimitBytes) },
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
    });
    return helper;
}

function prepareProcessIsolation(options = {}) {
    const spec = buildIsolationSpec(options);
    const cgroup = createLinuxCgroup(spec);
    return {
        spec,
        cgroup,
        attach(pid) {
            if (process.platform === 'linux') attachLinuxCgroup(cgroup, pid);
            if (process.platform === 'win32') return attachWindowsJob(pid, spec);
            return null;
        },
        cleanup() { cgroup?.cleanup(); }
    };
}

function isolationMetadata(isolation) {
    const spec = isolation?.spec || {};
    return {
        platform: process.platform,
        strict: spec.strict === true,
        memoryLimitBytes: spec.memoryLimitBytes || 0,
        osIsolation: process.platform === 'win32' ? 'windows-job-object' : process.platform === 'linux' ? (isolation?.cgroup ? 'linux-cgroup' : 'process-group') : 'process-tree',
        networkIsolation: spec.networkDisabled ? (process.platform === 'linux' ? 'network-namespace-requested' : 'policy-enforced') : 'policy-enforced'
    };
}

module.exports = { buildIsolationSpec, isolationMetadata, prepareProcessIsolation };
