// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SegDownCore",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "SegDownCore", targets: ["SegDownCore"]),
        .executable(name: "segdown-cli", targets: ["segdown-cli"]),
    ],
    targets: [
        .target(name: "SegDownCore"),
        .executableTarget(name: "segdown-cli", dependencies: ["SegDownCore"]),
        .testTarget(name: "SegDownCoreTests", dependencies: ["SegDownCore"]),
    ]
)
