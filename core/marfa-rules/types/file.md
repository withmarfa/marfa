**Use for**

- A file you keep, such as a PDF or a spreadsheet.

**Not for**

- Text with no file. That is a `core.note`.
- A web address with no saved file. That is a `core.bookmark`.

**Body**

- The file's bytes are stored with it. `title` is its name. A saved HTML page is a `core.file.webpage`.

**Edges**

- `attached-to` runs from this file to the item it belongs to. When saving the file, `attached-to` names that item.
