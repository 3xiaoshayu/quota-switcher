; Installer copy, extra pages, and font overrides.
; Included before installer.nsi, so these macros exist when MUI pages are inserted.

; Font helpers are installer-only. The uninstaller compile of this file
; would warn (treated as error) if these functions were unused.
!ifndef BUILD_UNINSTALLER
Var InstallerTitleFont
Var InstallerBodyFont

Function installerMakeFonts
  StrCmp $InstallerTitleFont "" 0 installerMakeFontsDone
  CreateFont $InstallerTitleFont "Microsoft YaHei UI" 18 700
  CreateFont $InstallerBodyFont "Microsoft YaHei UI" 13 400
  installerMakeFontsDone:
FunctionEnd

Function installerApplyWelcomeFonts
  Call installerMakeFonts
  GetDlgItem $0 $HWNDPARENT 1201
  SendMessage $0 0x0030 $InstallerTitleFont 1
  GetDlgItem $0 $HWNDPARENT 1202
  SendMessage $0 0x0030 $InstallerBodyFont 1
FunctionEnd
!endif

!macro customWelcomePage
  !define MUI_WELCOMEFINISHPAGE_BITMAP_NOSTRETCH
  !define MUI_WELCOMEPAGE_TITLE "$(installerWelcomeTitle)"
  !define MUI_WELCOMEPAGE_TITLE_3LINES
  !define MUI_WELCOMEPAGE_TEXT "$(installerWelcomeText)"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW installerWelcomeShow
  !insertmacro MUI_PAGE_WELCOME
  Function installerWelcomeShow
    Call installerApplyWelcomeFonts
  FunctionEnd
!macroend

!macro customUnWelcomePage
  !define MUI_UNWELCOMEFINISHPAGE_BITMAP_NOSTRETCH
  !define MUI_UNWELCOMEPAGE_TITLE "$(installerUnWelcomeTitle)"
  !define MUI_UNWELCOMEPAGE_TEXT "$(installerUnWelcomeText)"
  !insertmacro MUI_UNPAGE_WELCOME
  !define MUI_UNFINISHPAGE_TITLE "$(installerUnFinishTitle)"
  !define MUI_UNFINISHPAGE_TEXT "$(installerUnFinishText)"
!macroend

!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
    !define MUI_FINISHPAGE_RUN_TEXT "$(installerFinishRun)"
  !endif
  !define MUI_FINISHPAGE_TITLE "$(installerFinishTitle)"
  !define MUI_FINISHPAGE_TEXT "$(installerFinishText)"
  !define MUI_FINISHPAGE_NOREBOOTSUPPORT
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW installerFinishShow
  !insertmacro MUI_PAGE_FINISH
  Function installerFinishShow
    Call installerApplyWelcomeFonts
  FunctionEnd
!macroend

!macro customHeader
  BrandingText "Quota Switcher"

  LangString installerWelcomeTitle ${LANG_SIMPCHINESE} "欢迎安装"
  LangString installerWelcomeText ${LANG_SIMPCHINESE} "用来在这台电脑上管理 Codex、Cursor 和 Antigravity 账号、查看额度，并在额度不够时换号。$\r$\n$\r$\n账号只保存在这台电脑上，不会上传。$\r$\n$\r$\n点「下一步」继续。"
  LangString installerFinishTitle ${LANG_SIMPCHINESE} "安装完成"
  LangString installerFinishText ${LANG_SIMPCHINESE} "可以从开始菜单或桌面打开。$\r$\n$\r$\n账号数据只保存在这台电脑上。"
  LangString installerFinishRun ${LANG_SIMPCHINESE} "打开 Quota Switcher"
  LangString installerDirTop ${LANG_SIMPCHINESE} "程序会装到下面这个文件夹。没有特别需要，保持默认即可。"
  LangString installerDirDest ${LANG_SIMPCHINESE} "安装位置"
  LangString installerDirHeader ${LANG_SIMPCHINESE} "安装位置"
  LangString installerDirSubHeader ${LANG_SIMPCHINESE} "选择要把程序放到哪个文件夹"
  LangString installerFilesHeader ${LANG_SIMPCHINESE} "正在安装"
  LangString installerFilesSubHeader ${LANG_SIMPCHINESE} "请稍候，正在把文件复制到这台电脑。"
  LangString installerUnWelcomeTitle ${LANG_SIMPCHINESE} "卸载 Quota Switcher"
  LangString installerUnWelcomeText ${LANG_SIMPCHINESE} "将从这台电脑移除本程序。账号数据会留在原处，不会一起删掉。$\r$\n$\r$\n点「下一步」继续。"
  LangString installerUnFinishTitle ${LANG_SIMPCHINESE} "已经卸载"
  LangString installerUnFinishText ${LANG_SIMPCHINESE} "Quota Switcher 已从这台电脑移除。账号数据仍留在原处。"

  LangString installerWelcomeTitle ${LANG_ENGLISH} "Install Quota Switcher"
  LangString installerWelcomeText ${LANG_ENGLISH} "Manage Codex, Cursor, and Antigravity accounts, quotas, and switching on this PC.$\r$\n$\r$\nAccount data stays on this computer.$\r$\n$\r$\nClick Next to continue."
  LangString installerFinishTitle ${LANG_ENGLISH} "You're all set"
  LangString installerFinishText ${LANG_ENGLISH} "Open Quota Switcher from the Start menu or the desktop shortcut.$\r$\n$\r$\nAccount data stays on this computer."
  LangString installerFinishRun ${LANG_ENGLISH} "Open Quota Switcher"
  LangString installerDirTop ${LANG_ENGLISH} "The app will be installed in the folder below. You can keep the default."
  LangString installerDirDest ${LANG_ENGLISH} "Install location"
  LangString installerDirHeader ${LANG_ENGLISH} "Install location"
  LangString installerDirSubHeader ${LANG_ENGLISH} "Choose the folder for this app"
  LangString installerFilesHeader ${LANG_ENGLISH} "Installing"
  LangString installerFilesSubHeader ${LANG_ENGLISH} "Please wait while files are copied to this computer."
  LangString installerUnWelcomeTitle ${LANG_ENGLISH} "Uninstall Quota Switcher"
  LangString installerUnWelcomeText ${LANG_ENGLISH} "This removes the app from this computer. Account data is left in place.$\r$\n$\r$\nClick Next to continue."
  LangString installerUnFinishTitle ${LANG_ENGLISH} "Uninstall complete"
  LangString installerUnFinishText ${LANG_ENGLISH} "Quota Switcher has been removed. Account data was left in place."

  !pragma warning disable 6030
  LangString chooseInstallationOptions ${LANG_SIMPCHINESE} "安装范围"
  LangString whoShouldThisApplicationBeInstalledFor ${LANG_SIMPCHINESE} "选择给谁使用"
  LangString selectUserMode ${LANG_SIMPCHINESE} "可以只给当前用户装，也可以给这台电脑的所有人装。"
  LangString onlyForMe ${LANG_SIMPCHINESE} "只安装给我"
  LangString forAll ${LANG_SIMPCHINESE} "这台电脑的所有用户"
  LangString reinstallUpgrade ${LANG_SIMPCHINESE} "将更新已有安装。"
  LangString perUserInstallExists ${LANG_SIMPCHINESE} "当前用户已经装过："
  LangString perMachineInstallExists ${LANG_SIMPCHINESE} "这台电脑已经为所有用户装过："
  LangString freshInstallForCurrent ${LANG_SIMPCHINESE} "将只安装给当前用户。"
  LangString freshInstallForAll ${LANG_SIMPCHINESE} "将安装给所有用户，需要管理员权限。"
  LangString chooseUninstallationOptions ${LANG_SIMPCHINESE} "卸载范围"
  LangString whichInstallationShouldBeRemoved ${LANG_SIMPCHINESE} "要移除哪一份安装？"
  LangString whichInstallationRemove ${LANG_SIMPCHINESE} "本程序同时装过「当前用户」和「所有用户」。请选择要移除哪一份。"
  LangString perUserInstall ${LANG_SIMPCHINESE} "当前用户的安装："
  LangString perMachineInstall ${LANG_SIMPCHINESE} "所有用户的安装："
  LangString uninstall ${LANG_SIMPCHINESE} "将卸载这一份。"

  LangString chooseInstallationOptions ${LANG_ENGLISH} "Who can use this app"
  LangString whoShouldThisApplicationBeInstalledFor ${LANG_ENGLISH} "Choose who this install is for"
  LangString selectUserMode ${LANG_ENGLISH} "Install for the current Windows user, or for everyone on this PC."
  LangString onlyForMe ${LANG_ENGLISH} "Only for me"
  LangString forAll ${LANG_ENGLISH} "Anyone who uses this PC"
  LangString reinstallUpgrade ${LANG_ENGLISH} "This will update the existing install."
  LangString perUserInstallExists ${LANG_ENGLISH} "Already installed for this user:"
  LangString perMachineInstallExists ${LANG_ENGLISH} "Already installed for all users:"
  LangString freshInstallForCurrent ${LANG_ENGLISH} "Will install for the current user only."
  LangString freshInstallForAll ${LANG_ENGLISH} "Will install for all users. Administrator permission is required."
  LangString chooseUninstallationOptions ${LANG_ENGLISH} "Which copy to remove"
  LangString whichInstallationShouldBeRemoved ${LANG_ENGLISH} "Choose which install to remove"
  LangString whichInstallationRemove ${LANG_ENGLISH} "This app is installed both for you and for all users. Which copy should be removed?"
  LangString perUserInstall ${LANG_ENGLISH} "Current-user install:"
  LangString perMachineInstall ${LANG_ENGLISH} "All-users install:"
  LangString uninstall ${LANG_ENGLISH} "This copy will be removed."
  !pragma warning default 6030
!macroend

!macro customPageAfterChangeDir
  !include StrContains.nsh
  !define MUI_PAGE_HEADER_TEXT "$(installerDirHeader)"
  !define MUI_PAGE_HEADER_SUBTEXT "$(installerDirSubHeader)"
  !define MUI_DIRECTORYPAGE_TEXT_TOP "$(installerDirTop)"
  !define MUI_DIRECTORYPAGE_TEXT_DESTINATION "$(installerDirDest)"
  !insertmacro MUI_PAGE_DIRECTORY
  !define MUI_PAGE_CUSTOMFUNCTION_PRE ensureInstallerAppFolder
  Function ensureInstallerAppFolder
    ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
    ${If} $0 == ""
      StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
    ${EndIf}
  FunctionEnd

  !define MUI_PAGE_HEADER_TEXT "$(installerFilesHeader)"
  !define MUI_PAGE_HEADER_SUBTEXT "$(installerFilesSubHeader)"
!macroend
