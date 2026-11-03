; Extra steps for the Windows installer (see bundle > windows > nsis > installerHooks).

!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove the "start with Windows" entry so Windows doesn't try to start a
  ; program that's no longer there. Skipped when the uninstaller only runs as
  ; part of updating to a newer version.
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Daily Planner"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Daily Planner"
  ${EndIf}
!macroend
