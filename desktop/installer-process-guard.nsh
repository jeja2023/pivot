; 只核对安装目录内的进程；直接查询 Win32，不依赖 CIM/WMI 或 PowerShell 模块。
!include FileFunc.nsh

!macro PivotInstallerStage MESSAGE
  System::Store "s F"
  System::Call 'kernel32::GetCurrentProcessId() i.r7'
  ClearErrors
  FileOpen $8 "$TEMP\PivotInstaller-$7.log" a
  IfErrors +4
  FileSeek $8 0 END
  FileWriteUTF16LE $8 "${MESSAGE}：$INSTDIR$\r$\n"
  FileClose $8
  System::Store "f l"
  DetailPrint "${MESSAGE}"
!macroend

!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend

!macro customInit
  !insertmacro PivotInstallerStage "开始安装"
!macroend

!macro customInstall
  !insertmacro PivotInstallerStage "安装文件部署完成"
!macroend

!macro customUnInstall
  !insertmacro PivotInstallerStage "开始卸载旧文件"
!macroend

!macro customCheckAppRunning
  !insertmacro PivotInstallerStage "正在检查安装目录进程"
  System::Store "s"
  StrCpy $R0 -1
  StrCpy $R1 0
  StrCpy $R2 0
  StrCpy $R9 3
  StrCpy $4 0
  StrCpy $5 0
  System::Call 'kernel32::GetCurrentProcessId() i.r7'
  ${GetParameters} $6
  ClearErrors
  ${GetOptions} $6 "--updated" $6
  IfErrors +2
  StrCpy $5 40

  System::Call 'shlwapi::PathIsRelativeW(w "$INSTDIR") i.r0'
  StrCmp $0 0 0 bi_process_check_cleanup
  System::Call 'kernel32::GetFullPathNameW(w "$INSTDIR", i ${NSIS_MAX_STRLEN}, w.R7, p 0) i.r0'
  IntCmp $0 0 bi_process_check_cleanup
  IntCmp $0 ${NSIS_MAX_STRLEN} bi_process_check_cleanup 0 bi_process_check_cleanup
  System::Call 'kernel32::GetFileAttributesW(w R7) i.r0 ?e'
  Pop $1
  StrCmp $0 -1 bi_process_check_missing_directory
  IntOp $0 $0 & 0x10
  StrCmp $0 0 bi_process_check_cleanup bi_process_check_normalize
  bi_process_check_missing_directory:
    StrCmp $1 2 bi_process_check_normalize
    StrCmp $1 3 bi_process_check_normalize bi_process_check_cleanup
  bi_process_check_normalize:
    StrCpy $0 $R7 1 -1
    StrCmp $0 "\" +2
    StrCpy $R7 "$R7\"
    StrLen $R8 $R7

  bi_process_check_snapshot:
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) p.R0'
  StrCmp $R0 -1 bi_process_check_cleanup
  ; 项目使用 32 位 NSIS，PROCESSENTRY32W 为 556 字节；完整路径查询可读取 64 位进程。
  System::Alloc 556
  Pop $R1
  StrCmp $R1 0 bi_process_check_cleanup
  System::Call '*$R1(i 556)'
  System::Call 'kernel32::Process32FirstW(p R0, p R1) i.R3'
  StrCmp $R3 0 bi_process_check_cleanup
  bi_process_check_loop:
    System::Call '*$R1(i, i, i.R4, i, i, i, i, i, i, &w260.R5)'
    StrCmp $R4 0 bi_process_check_next
    StrCmp $R4 4 bi_process_check_next
    ; 原位卸载时卸载器位于安装目录，不能把正在执行检查的自身当作客户端阻断。
    StrCmp $R4 $7 bi_process_check_next
    System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i R4) p.R2 ?e'
    Pop $0
    StrCmp $R2 0 bi_process_check_unresolved
    StrCpy $2 ${NSIS_MAX_STRLEN}
    System::Call 'kernel32::QueryFullProcessImageNameW(p R2, i 0, w.R6, *i r2) i.R3 ?e'
    Pop $0
    System::Call 'kernel32::CloseHandle(p R2)'
    StrCpy $R2 0
    StrCmp $R3 0 bi_process_check_unresolved
    StrCpy $1 $R6 $R8
    System::Call 'kernel32::CompareStringOrdinal(w r1, i -1, w R7, i -1, i 1) i.R3'
    StrCmp $R3 0 bi_process_check_cleanup
    StrCmp $R3 2 bi_process_check_running bi_process_check_next
  bi_process_check_unresolved:
    ; 已退出的进程可忽略；目标客户端无法查询时仍停止覆盖，不因同名而终止其它实例。
    StrCmp $0 87 bi_process_check_next
    StrCmp $R5 "${APP_EXECUTABLE_FILENAME}" bi_process_check_mark_unresolved
    IfFileExists "$R7$R5" bi_process_check_mark_unresolved bi_process_check_next
  bi_process_check_mark_unresolved:
    StrCpy $4 3
  bi_process_check_next:
    System::Call 'kernel32::Process32NextW(p R0, p R1) i.R3 ?e'
    Pop $0
    StrCmp $R3 0 0 bi_process_check_loop
    StrCmp $0 18 0 bi_process_check_cleanup
    StrCpy $R9 $4
    Goto bi_process_check_cleanup
  bi_process_check_running:
    StrCpy $R9 2
  bi_process_check_cleanup:
    StrCmp $R2 0 +2
    System::Call 'kernel32::CloseHandle(p R2)'
    StrCmp $R1 0 +2
    System::Free $R1
    StrCmp $R0 -1 +2
    System::Call 'kernel32::CloseHandle(p R0)'
    StrCmp $R9 2 0 bi_process_check_result
    StrCmp $5 0 bi_process_check_result
    ; 更新器先启动安装器再退出客户端，最多等待十秒自然退出，不终止任何进程。
    IntOp $5 $5 - 1
    Sleep 250
    StrCpy $R0 -1
    StrCpy $R1 0
    StrCpy $R2 0
    StrCpy $R9 3
    StrCpy $4 0
    Goto bi_process_check_snapshot
  bi_process_check_result:
    Push $R9
    System::Store "l"
    Pop $0
    ClearErrors
    StrCmp $0 0 bi_process_check_done
    StrCmp $0 2 bi_target_still_running bi_process_check_failed
  bi_target_still_running:
    MessageBox MB_OK|MB_ICONSTOP "安装目录中的客户端仍在运行，请关闭该客户端后重新安装。" /SD IDOK
    SetErrorLevel 1
    Quit
  bi_process_check_failed:
    MessageBox MB_OK|MB_ICONSTOP "无法核对安装目录的运行状态，已停止安装。请联系维护者检查安装目录或系统进程查询权限。" /SD IDOK
    SetErrorLevel 1
    Quit
  bi_process_check_done:
    !insertmacro PivotInstallerStage "目录进程检查通过，正在处理旧版本或安装文件"
!macroend
