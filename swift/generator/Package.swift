// swift-tools-version: 6.0
// The generator, pinned, as a package of its own so the types package
// depends only on the runtime its generated code needs.
import PackageDescription

let package = Package(
    name: "MarfaTypesGenerator",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", exact: "1.13.1"),
    ]
)
