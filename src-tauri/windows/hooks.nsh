; Ludora-Installer (Rust/Tauri): Umstieg von der Electron-Version (bis 0.7.x).
; Die alte Installation wird still entfernt und die neue App an ihren Platz gesetzt (gleicher Ordner,
; gleicher Name Ludora.exe), damit es nicht zwei Ludora gibt. Installiert wird für alle Benutzer
; (wie die Electron-Version unter C:\Program Files\Ludora) – dafür fragt Windows einmal nach Admin-Rechten.
; Einstellungen, Anmeldungen und Cover bleiben erhalten (gleicher Datenordner %APPDATA%\Ludora).

; Autostart der alten Version ("electron.app.Ludora") merken und auf die neue App umstellen
Var LudoraAutostart
; Ordner der alten Version: dorthin installieren, damit Verknüpfungen, Autostart und der Neustart des
; alten Updaters ("…\Ludora.exe --after-update") direkt die neue App treffen
Var LudoraOldDir

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
      ${If} $LudoraOldDir == ""
        StrCpy $LudoraOldDir $R2
      ${EndIf}
      ; _?= : Deinstallation an Ort und Stelle und darauf warten
      ExecWait '"$R2\Uninstall Ludora.exe" ${FLAG} /S _?=$R2'
      Delete "$R2\Uninstall Ludora.exe"
      RMDir "$R2"
    ${EndIf}
  ${Loop}
!macroend

!macro NSIS_HOOK_PREINSTALL
  StrCpy $LudoraOldDir ""
  StrCpy $LudoraAutostart ""
  ReadRegStr $LudoraAutostart HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Ludora"
  ${If} $LudoraAutostart != ""
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Ludora"
  ${EndIf}
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
  ; Die neue App ersetzt die alte am selben Ort (gleicher Pfad zu Ludora.exe)
  ${If} $LudoraOldDir != ""
    StrCpy $INSTDIR $LudoraOldDir
    CreateDirectory $INSTDIR
  ${EndIf}
  SetOutPath $INSTDIR
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; War Autostart in der alten Version an: für die neue App eintragen (gleicher Name wie die App selbst)
  ${If} $LudoraAutostart != ""
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Ludora" '"$INSTDIR\Ludora.exe" --hidden'
  ${EndIf}
!macroend
