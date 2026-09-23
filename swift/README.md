# MarfaTypes

The Swift types for a Marfa instance, generated from the repository's `openapi.json` by [swift-openapi-generator](https://github.com/apple/swift-openapi-generator): every schema, and each operation's input and output. Types only: nothing here sends a request, so a Swift consumer chooses its own transport.

`marfaContractVersion` is the contract the types were generated for, the number an instance's root answers as `contract`. A consumer compares the two before it trusts an answer.

## Generating

`pnpm generate` at the repository root builds the generator pinned in `generator/`, writes `Sources/MarfaTypes/` from `openapi.json` under `openapi-generator-config.yaml`, and writes `Contract.swift` with `generate-contract.ts`. Nothing under `Sources/` is edited by hand; CI's "Generated clients are fresh" job regenerates it and refuses a difference, and "Swift types build" compiles it and runs the tests.

One schema is overridden in the configuration: `HousekeepingReport` is read as an `OpenAPIObjectContainer`, because the generator cannot express its values, any scalar or null.
