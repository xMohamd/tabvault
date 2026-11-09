# TabVault documentation

| Page | For | What's inside |
|---|---|---|
| [Glossary](../CONTEXT.md) | Everyone | The project's terms: Backup, Snapshot, Import, Restore, load modes |
| [User guide](user-guide.md) | Users | Export, Import and Restore, automatic backups, search, shortcuts, troubleshooting |
| [Architecture](architecture.md) | Contributors | The parts of the extension, messages, data flow, where data lives, browser differences |
| [Backup format](backup-format.md) | Contributors | The Backup file layout field by field, version rules, encryption, other formats |
| [Testing](testing.md) | Contributors | Test levels, the strict fake browser, running real-browser tests, CI |
| [Releasing](releasing.md) | Maintainers | Versioning, building, store submission |
| [Privacy](privacy.md) | Users, store reviewers | What is stored where, network use, why each permission |
| [Decisions](adr/) | Contributors | Short records of choices that might otherwise look like mistakes |

## Decisions

1. [Keep the Backup format compatible with chromium-tab-migrator](adr/0001-keep-backup-format-compatible.md)
2. [No network access](adr/0002-no-network-access.md)
3. [Save files through data: URLs and import modules statically in the background](adr/0003-service-worker-constraints.md)
4. [Remember the chosen backup folder in IndexedDB](adr/0004-backup-folder-in-indexeddb.md)
5. [Open file and folder pickers in a full tab](adr/0005-pickers-open-in-a-tab.md)
6. [Keyboard shortcuts avoid Alt+Shift](adr/0006-shortcuts-avoid-alt-shift.md)
7. [Test against a strict fake browser](adr/0007-strict-fake-browser.md)

Add a decision only when it is hard to reverse, would surprise a new reader, and came from a real
trade-off. Number it after the last one; a short paragraph is enough.
