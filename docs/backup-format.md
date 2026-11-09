# Backup format

Every Backup file TabVault writes is a JSON document in **Backup format 1.1**. Snapshots use
the same structure. The definition lives in `src/lib/schema.ts`, which is the single source of
truth; this page describes it.

The format is shared with [chromium-tab-migrator](https://github.com/rennerdo30/chromium-tab-migrator),
the project TabVault is based on, so files move between the two in both directions
([ADR 0001](adr/0001-keep-backup-format-compatible.md)).

## Example

```json
{
  "schemaVersion": "1.1",
  "exportedAt": "2026-11-08T18:30:00.000Z",
  "source": { "browser": "chrome", "extensionVersion": "1.0.0", "groupSystem": "tabGroups" },
  "windows": [
    {
      "state": "maximized",
      "ungroupedTabs": [
        { "title": "Inbox", "url": "https://mail.example.com/", "pinned": true, "index": 0 }
      ],
      "groups": [
        {
          "title": "Research", "color": "green", "collapsed": false,
          "tabs": [{ "title": "MDN", "url": "https://developer.mozilla.org/", "pinned": false, "index": 1 }]
        }
      ]
    }
  ],
  "bookmarks": [
    { "title": "Bookmarks bar", "folderType": "bookmarks-bar",
      "children": [{ "title": "Wikipedia", "url": "https://en.wikipedia.org/" }] }
  ]
}
```

## Fields

**Backup** (top level)

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | string | `"1.1"`. Missing means `"1.0"`. |
| `exportedAt` | ISO date or `null` | When the Backup was made |
| `source` | object | Where it came from: `browser`, `browserName`, `extensionVersion`, `groupSystem`, `filtersApplied`; converters set `format` and, if a file hit the tab limit, `truncated`. Free-form: unknown keys are kept. |
| `windows` | Window[] | May be empty |
| `bookmarks` | Bookmark[] | Top-level bookmark folders; may be empty |

At least one of `windows` and `bookmarks` must be an array.

**Window**

| Field | Type | Notes |
|---|---|---|
| `ungroupedTabs` | Tab[] | Tabs outside any group |
| `groups` | Group[] | Tab groups, in order |
| `title` | string? | A label shown in the import preview (e.g. a Session Buddy collection) |
| `state` | string? | `normal`, `maximized`, `minimized` or `fullscreen` |
| `left`, `top`, `width`, `height` | number? | Window position and size, when exported with layout |
| `focused` | boolean? | The window that had focus |
| `metadata` | object? | Import hints from converters |

**Group**: `title`, `color` (`grey`, `blue`, `red`, `yellow`, `green`, `pink`, `purple`,
`cyan`, `orange`; anything else becomes `grey`), `collapsed`, `tabs`, optional `metadata`.

**Tab**

| Field | Type | Notes |
|---|---|---|
| `url`, `title` | string | |
| `pinned` | boolean | |
| `index` | number? | **New in 1.1.** The tab's position in its window. With it, grouped and ungrouped tabs are restored in their exact original order; without it, ungrouped tabs come first, then each group. |
| `active` | boolean? | The selected tab of its window |
| `favIconUrl` | string? | Only when exported with icons |
| `container` | object? | Firefox container: `name`, `color`, `icon`; matched by name on Restore |
| `metadata` | object? | Free-form |

**Bookmark**: the shape of the browser's bookmark tree. `title`; `url` for a bookmark;
`children` for a folder; optional `folderType` (e.g. `bookmarks-bar`), `type` (Firefox:
`bookmark`, `folder`, `separator`), `id`, `parentId`, `index`, `dateAdded`.

## Version rules

- **Reading 1.0 files:** supported. Tabs have no `index`, so the mixed order of grouped and
  ungrouped tabs can't be reproduced.
- **Newer files:** a major version above 1 is still read, with a warning that the Backup was
  made by a newer version and some details may be missing.
- **Invalid entries** (a tab without an address, a malformed window) are dropped one by one and
  counted in the import warnings; the rest of the file still imports. A file with neither
  `windows` nor `bookmarks` is rejected.
- **Changing the format:** additive, optional fields only, and bump the minor version. Renaming
  or removing a field breaks compatibility with existing files and with the original project.

## Password-protected files

An encrypted Backup file is a JSON envelope instead of a Backup:

```json
{
  "format": "tabvault-encrypted",
  "version": 1,
  "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<base64>" },
  "cipher": { "name": "AES-GCM", "iv": "<base64>" },
  "data": "<base64 ciphertext of the Backup JSON>"
}
```

The key is derived from the password with PBKDF2-HMAC-SHA256; the Backup JSON is encrypted with
AES-256-GCM. A wrong password and a modified file give the same error (GCM can't tell them
apart). The password is never stored. See `src/lib/crypto.ts`.

## Other formats on Import

`src/lib/formats/` detects the file type and converts it into a Backup before the preview:

| Format | Notes |
|---|---|
| TabVault / chromium-tab-migrator | Native; validated as above |
| Session Buddy | Backups and JSON exports: saved collections and browser-closed history, with groups and window layout. Only the newest history snapshot is selected by default. |
| OneTab | The text export (one URL and title per line, blank lines between groups) |
| Bookmark HTML | The Netscape format every browser exports |
| Firefox bookmark JSON | Firefox's own bookmark backup |
| URL list | Plain text, one address per line |

Limits: files up to 50 MB, and converters stop at 20,000 tabs (the Backup is then marked
`truncated`).
