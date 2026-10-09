// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MiaoCore",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "MiaoCore", targets: ["MiaoCore"])],
    targets: [
        .target(name: "MiaoCore"),
        .testTarget(name: "MiaoCoreTests", dependencies: ["MiaoCore"], resources: [.copy("Fixtures")]),
        .executableTarget(name: "InteropProbe", dependencies: ["MiaoCore"]),
        .executableTarget(name: "TransportProbe", dependencies: ["MiaoCore"]),
        .executableTarget(name: "PairingProbe", dependencies: ["MiaoCore"]),
        .executableTarget(name: "HubAccountProbe", dependencies: ["MiaoCore"])
    ]
)
