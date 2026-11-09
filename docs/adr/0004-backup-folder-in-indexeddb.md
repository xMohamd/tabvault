# Remember the chosen backup folder in IndexedDB

In Chromium, the user can pick any folder for automatic backup files with the File System
Access API. The resulting folder handle can't be stored in `browser.storage` (it only holds
JSON), but it can be stored in IndexedDB, which both the popup (which picks the folder) and the
background (which writes the files) can open. The browser may later withdraw write permission;
files then go to Downloads and the popup offers "Allow access". Firefox has no folder picker,
so there the user can only choose a folder inside Downloads.
