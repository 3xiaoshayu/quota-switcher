; Show the install-directory page even on upgrades.
; electron-builder wraps its own directory page in skipPageIfUpdated,
; so a reinstall never lets the user pick a folder. This page is inserted
; after that (and after MUI2), so LogicLib is available.

!macro customPageAfterChangeDir
  !include StrContains.nsh
  !insertmacro MUI_PAGE_DIRECTORY
  !define MUI_PAGE_CUSTOMFUNCTION_PRE ensureInstallerAppFolder
  Function ensureInstallerAppFolder
    ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
    ${If} $0 == ""
      StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
    ${EndIf}
  FunctionEnd
!macroend
