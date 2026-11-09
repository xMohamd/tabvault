# User guide

TabVault keeps your tabs, tab groups and bookmarks safe and brings them back, in the same
browser or another one. Click the toolbar icon (or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>)
to open it. It has three tabs: **Export**, **Import** and **Backups**.

## Save everything to a file (Export)

1. Open the **Export** tab. The counters show how many tabs, windows, groups and bookmarks
   will be saved.
2. Choose what to include: **Tabs & groups**, **Bookmarks** (and bookmarklets).
3. Optional, under **Filters**: only certain websites, or skip browser pages.
   Under **Options**: tab icons, window size and position, and **password protection**.
4. Click **Export**. The file goes to your Downloads folder.

Keep the password safe: a protected file can't be opened without it.

## Bring tabs and bookmarks back (Import and Restore)

1. Open the **Import** tab and choose a file, or drop it on the popup. In the popup, choosing a
   file opens TabVault in a tab, because the browser would close the popup while the file dialog
   is open.
2. TabVault reads its own files and also OneTab, Session Buddy, bookmark HTML, Firefox bookmark
   backups and plain lists of addresses.
3. Review the preview. Tick the windows and groups you want, or search the file and tick
   individual tabs and bookmarks.
4. Choose how to restore:
   - **Open in:** new windows, or the current window. **Add to groups with the same name**
     puts tabs into a matching existing group instead of creating a second one.
   - **Loading:** *Don't load until opened* (lightest on memory), *Placeholder page* (a tiny
     TabVault page until you open the tab), or *Load everything*.
   - **Bookmarks:** *Merge* into your folders, put them *into a dated folder*, or *Replace
     existing*. Replace deletes your current bookmarks, so TabVault first saves a Safety
     snapshot you can restore from.
5. Click **Restore**. You can close the popup: the Restore continues, and the results list
   anything that couldn't be restored and why.

## Move to another browser

Export in the old browser, install TabVault in the new one, then Import and Restore the file
there. Tab groups, pinned tabs and order are kept. Browsers without tab groups get one window
per group.

## Automatic backups (Backups)

The **Backups** tab lists your Snapshots: copies TabVault keeps inside the browser.

- **Back up now** saves a Snapshot immediately.
- Under **Automatic backups**: back up hourly, daily or weekly and choose how many to keep.
  Unchanged state is not saved twice.
- **Also save each backup as a file** keeps a copy that survives removing the extension. Files
  go to *Downloads/TabVault*; in Chrome, Edge and other Chromium browsers you can **choose any
  folder**, and in Firefox you can choose a folder inside Downloads.
- Each Snapshot can be **restored**, **searched**, **downloaded** as a file, or **deleted**.
  **Compare…** shows what changed between two Snapshots.

Snapshots are stored only in this browser: removing TabVault removes them. Use Export or backup
files for copies you want to keep.

## Search

Type in the search box on the **Backups** tab to look through every Snapshot (and the file
loaded on the Import tab) for a page or bookmark. **All backups** lets you pick which ones to
search. Tick results and click **Restore N selected**.

## Quick saves

Right-click the toolbar icon or a page and choose **Save this window as a snapshot** or **Save
this tab group as a snapshot**. Keyboard shortcuts:

| Shortcut | Action |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> | Open TabVault |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>.</kbd> | Back up now |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>,</kbd> | Save this window |

On macOS use <kbd>Command</kbd>. The **⋯** menu → **Keyboard shortcuts** shows the shortcuts
your browser actually assigned and opens its settings to change them.

## Troubleshooting

| Problem | What to do |
|---|---|
| The file picker closes the popup | Use the tab TabVault opens, or drag the file onto the popup |
| "This backup was made by a newer version" | Update TabVault; most of the file still restores |
| Some tabs weren't restored | The results list the reason; browser-internal pages (settings, other extensions) can't be opened by extensions |
| Backup files go to Downloads instead of the chosen folder | The browser needs permission again: open Backups → Automatic backups and click **Allow access** |
| Shortcuts don't work | Another program or the browser may use them; change them from **⋯** → **Keyboard shortcuts** |
| Something else | **⋯** → **Copy diagnostics** copies a report without any page addresses, to attach to an issue |
