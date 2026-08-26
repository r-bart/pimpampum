// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "PimpampumMenuBar",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "PimpampumMenuBar", targets: ["PimpampumMenuBar"]),
    ],
    targets: [
        .executableTarget(
            name: "PimpampumMenuBar",
            path: "Sources/PimpampumMenuBar"
        ),
        .testTarget(
            name: "PimpampumMenuBarTests",
            dependencies: ["PimpampumMenuBar"],
            path: "Tests/PimpampumMenuBarTests"
        ),
    ]
)
