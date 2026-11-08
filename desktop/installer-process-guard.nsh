; 只核对安装目录内的进程，避免同名的其它安装实例受到影响。
; 目录通过进程私有环境传递，含引号的路径也不会进入脚本文本。
!macro customCheckAppRunning
  System::Call 'kernel32::SetEnvironmentVariable(t "PIVOT_INSTALLER_TARGET_DIR", t "$INSTDIR") i.r0'
  StrCmp $0 0 bi_process_check_failed
  nsExec::Exec /TIMEOUT=30000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$ErrorActionPreference=$\'Stop$\'; try { Import-Module ($$env:SystemRoot+$\'\System32\WindowsPowerShell\v1.0\Modules\CimCmdlets\CimCmdlets.psd1$\') -ErrorAction Stop; $$target=[IO.Path]::GetFullPath($$env:PIVOT_INSTALLER_TARGET_DIR).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar; $$running=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and ([IO.Path]::GetFullPath($$_.ExecutablePath)).StartsWith($$target,[StringComparison]::OrdinalIgnoreCase) }); if ($$running.Count -eq 0) { exit 0 } else { exit 2 } } catch { exit 3 }"'
  Pop $0
  StrCmp $0 0 bi_process_check_done
  StrCmp $0 2 bi_target_still_running bi_process_check_failed
  bi_target_still_running:
    MessageBox MB_OK|MB_ICONSTOP "安装目录中的客户端仍在运行，请关闭该客户端后重新安装。" /SD IDOK
    SetErrorLevel 1
    Quit
  bi_process_check_failed:
    MessageBox MB_OK|MB_ICONSTOP "无法核对安装目录的运行状态，已停止安装。请联系维护者检查系统进程查询服务。" /SD IDOK
    SetErrorLevel 1
    Quit
  bi_process_check_done:
!macroend
