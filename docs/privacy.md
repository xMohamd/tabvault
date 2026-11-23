# Privacy

**TabVault does not collect, send or sell any data.** It has no servers, no accounts, no
analytics and no remote code. Everything it handles stays on your device.

## What TabVault stores, and where

| What | Where | How long |
|---|---|---|
| Snapshots (your tabs, groups and bookmarks) | The browser's extension storage, on this device | Until you delete them, they are pruned by your "keep" setting, or the extension is removed |
| Automatic-backup settings and the result of the last run | Extension storage | Until the extension is removed |
| Progress and result of the current Restore | Session storage | Until the browser closes or you dismiss the result |
| The backup folder you chose (Chromium) | The extension's IndexedDB | Until you choose another or click "Use default" |
| Light/dark theme preference | The extension's local storage | Until the extension is removed |
| Backup files | Files on your disk (Downloads or the folder you chose) | Until you delete them |

Password-protected files are encrypted on your device (PBKDF2-SHA256, AES-256-GCM). The password
is never stored or logged. Snapshots inside the browser are not encrypted.

**Copy diagnostics** creates a report for troubleshooting: browser and extension versions,
the state of the last Restore and recent error messages. It contains no page addresses or titles,
and it is only copied to your clipboard; nothing is sent anywhere.

## Network

TabVault makes no network requests of its own. Pages open only when you restore them. With the
*Placeholder page* load mode, the placeholder may show the website's icon, which your browser
loads from that website, as it would for any open tab.

## Permissions

| Permission | Why TabVault needs it |
|---|---|
| `tabs` | Read open tabs to back them up; open tabs when restoring |
| `tabGroups` | Read and recreate tab groups (name, color, collapsed state) |
| `bookmarks` | Back up and restore bookmarks |
| `downloads` | Save Backup files to your Downloads folder; delete old automatic backup files it created |
| `storage`, `unlimitedStorage` | Keep Snapshots and settings on your device; Snapshots can exceed the default storage limit |
| `alarms` | Run automatic backups on schedule |
| `contextMenus` | "Save this window / tab group as a snapshot" in the right-click menu |
| `contextualIdentities`, `cookies` (Firefox only) | Read container names and reopen tabs in the right container |

TabVault doesn't request access to the content of websites, and it doesn't run in private
(incognito) windows.

## Contact

Questions or concerns: [open an issue](https://github.com/xMohamd/tabvault/issues) on GitHub.
