# Open file and folder pickers in a full tab

Browsers close an extension's toolbar popup when it loses focus, and opening a native file or
folder dialog takes focus away (always in Firefox; in Chromium on Linux and other setups). The
popup is destroyed together with the picked file. So in the popup, "choose a file" and "Choose
folder…" open the same page as a full tab (`popup.html?view=tab`) and pick there; dropping a
file onto the popup still works, because it opens no dialog.
