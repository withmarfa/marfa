// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "marfa-core-example",
    platforms: [.macOS(.v15)],
    dependencies: [
        // build.sh output, not in the tree.
        .package(path: "../MarfaCore")
    ],
    targets: [
        .executableTarget(
            name: "marfa-core-example",
            dependencies: [.product(name: "MarfaCore", package: "MarfaCore")],
            swiftSettings: [.swiftLanguageMode(.v6)]
        )
    ]
)
