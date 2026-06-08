// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Firelink",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "Firelink", targets: ["Firelink"])
    ],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.4")
    ],
    targets: [
        .executableTarget(
            name: "Firelink",
            dependencies: [
                .product(name: "Sparkle", package: "Sparkle")
            ],
            path: "Sources/Firelink",
            resources: [
                .process("Assets.xcassets"),
                .copy("yt-dlp"),
                .copy("ffmpeg")
            ]
        )
    ]
)
