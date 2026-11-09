# TabVault

A browser extension that keeps people's tabs, tab groups and bookmarks safe, and brings
them back in any supported browser.

## Language

### What is kept

**Backup**:
One captured state of a browser's windows, tab groups, tabs and bookmarks, wherever it is kept.
_Avoid_: session, archive, save

**Snapshot**:
A Backup kept inside the browser by TabVault; it is lost if the extension is removed.
_Avoid_: backup (for this specific meaning), restore point

**Backup file**:
A Backup saved as a file, so it survives the browser and can move to another one.
_Avoid_: export (as a noun), dump

**Backup format**:
The versioned layout every Backup file follows; it stays compatible with the original project's files.
_Avoid_: schema (in user-facing text)

### Kinds of Snapshot

**Automatic snapshot**:
A Snapshot taken on the user's schedule.
_Avoid_: scheduled backup

**Manual snapshot**:
A Snapshot the user asks for on the spot ("Back up now").

**Quick save**:
A partial Snapshot of a single window or tab group, taken from the right-click menu or a shortcut.
_Avoid_: quick backup

**Safety snapshot**:
A Snapshot TabVault takes by itself just before a Restore replaces the user's bookmarks, the only step that deletes existing data.
_Avoid_: pre-import backup, before-import snapshot

### What the user does

**Export**:
Turning the browser's current state into a Backup file.

**Import**:
Reading a file (a Backup file or another app's format) into a Backup the user can review.
_Avoid_: restore (for this step), load

**Restore**:
Recreating tabs, tab groups and bookmarks in the browser from a Backup, whether it came from a file, a Snapshot or search results.
_Avoid_: import (for this step), migrate

Moving to another browser is an Export followed by an Import and Restore there; it is not a separate concept.
_Avoid_: migration, migrate, transfer

### How restored tabs open

**Load mode**:
How each restored tab opens: Unloaded, Placeholder or Loaded.
_Avoid_: restore mode, lazy, discarded

**Unloaded**:
The tab exists but the browser has not loaded the page yet; it loads when first opened.

**Placeholder**:
A lightweight TabVault page standing in for the real one until the user opens it.
_Avoid_: lazy page

**Suspended tab**:
A tab parked by another extension (a tab suspender) whose real address TabVault recovers on Export and Restore.
_Avoid_: placeholder (that is TabVault's own)
