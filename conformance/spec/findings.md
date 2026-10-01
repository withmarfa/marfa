# Findings

Where the server contradicts its own OpenAPI document, where its document describes something a caller cannot observe, where it contradicts the device half of this specification, or where two doors that answer the same question answer it differently. Each entry names the operation, what the document says, what the server does, and the fixture that shows it. The fixtures assert what the server does; nothing here is fixed on the suite's side, and nothing is a proposal. This file is the channel to the server's maintainers.

**An entry goes when the behavior it recorded changes, never because the contract softened.** Once the server answers as the document says, or the document says what the server does, the entry has nothing left to record, and the fixtures that asserted the old answer assert the new one.
