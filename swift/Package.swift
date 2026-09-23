// swift-tools-version: 6.0
// The Swift types for a Marfa instance, generated from `openapi.json` by
// swift-openapi-generator: the models and each operation's input and output,
// with no transport. `generator/` pins the generator and `pnpm generate`
// runs it.
import PackageDescription

let package = Package(
    name: "MarfaTypes",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "MarfaTypes", targets: ["MarfaTypes"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.11.0"),
    ],
    targets: [
        .target(
            name: "MarfaTypes",
            dependencies: [
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
            ]
        ),
        .testTarget(name: "MarfaTypesTests", dependencies: ["MarfaTypes"]),
    ]
)
