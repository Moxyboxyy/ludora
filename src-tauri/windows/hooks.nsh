; Ludora-Installer (Rust/Tauri): Umstieg von der Electron-Version (bis 0.7.x).
; Die alte Installation wird still entfernt, damit es nicht zwei Ludora gibt.
; Einstellungen, Anmeldungen und Cover bleiben erhalten (gleicher Datenordner %APPDATA%\Ludora).

!macro LUDORA_REMOVE_ELECTRON ROOT FLAG
  StrCpy $R0 0
  ${Do}
    EnumRegKey $R1 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R0
    ${If} $R1 == ""
      ${Break}
    ${EndIf}
    IntOp $R0 $R0 + 1
    ReadRegStr $R2 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "InstallLocation"
    ReadRegStr $R3 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R1" "DisplayName"
    StrCpy $R4 $R3 6
    ${If} $R2 != ""
    ${AndIf} $R4 == "Ludora"
    ${AndIf} ${FileExists} "$R2\Uninstall Ludora.exe"
      DetailPrint "Alte Ludora-Version (Electron) wird entfernt: $R2"
      ; _?= : Deinstallation an Ort und Stelle und darauf warten
      ExecWait '"$R2\Uninstall Ludora.exe" ${FLAG} /S _?=$R2'
      Delete "$R2\Uninstall Ludora.exe"
      RMDir "$R2"
    ${EndIf}
  ${Loop}
!macroend

!macro NSIS_HOOK_PREINSTALL
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  !insertmacro LUDORA_REMOVE_ELECTRON HKCU "/currentuser"
  !insertmacro LUDORA_REMOVE_ELECTRON HKLM "/allusers"
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  SetOutPath $INSTDIR
!macroend
