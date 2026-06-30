# Codex Account Manager

A local Windows desktop tool for switching Codex accounts, monitoring quota,
refreshing tokens, configuring automatic switching, and managing reset credits.

> This is an independent community project. It is not affiliated with,
> authorized by, or endorsed by OpenAI.

## Requirements

- Windows 10/11 x64
- The official Microsoft Store build of Codex
- Network access to the official OpenAI OAuth and ChatGPT endpoints

Account data is stored under `%USERPROFILE%\.codex-switch`. OAuth tokens are
encrypted with Windows DPAPI and can only be decrypted by the same Windows
login. The application does not operate a separate cloud service.

Private beta packages are distributed only to invited testers. Public releases
will include an NSIS installer, a ZIP archive, and `SHA256SUMS.txt`. Initial
packages are unsigned and may trigger a Windows SmartScreen warning.

Beta builds use manual updates. Stable public builds will automatically
download updates and prompt before restarting to install them.

Source code is licensed under the [MIT License](LICENSE). The Fuji background
has a separate distribution license described in [ASSET_LICENSE.md](ASSET_LICENSE.md).
