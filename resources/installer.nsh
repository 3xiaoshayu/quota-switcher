; Show the install-directory page even on upgrades.
; electron-builder's own directory page is wrapped in skipPageIfUpdated,
; so a reinstall never lets the user pick a folder.

!include StrContains.nsh

Function ensureInstallerAppFolder
  ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
  ${If} $0 == ""
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${EndIf}
FunctionEnd

!macro customPageAfterChangeDir
  !insertmacro MUI_PAGE_DIRECTORY
  !define MUI_PAGE_CUSTOMFUNCTION_PRE ensureInstallerAppFolder
!macroend
