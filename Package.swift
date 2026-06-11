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
    dependencies: [],
    targets: [
        .executableTarget(
            name: "Firelink",
            dependencies: [],
            path: "Sources/Firelink",
            exclude: [
                "deno-version.txt",
                "ffmpeg-version.txt"
            ],
            resources: [
                .process("Assets.xcassets"),
                .copy("yt-dlp"),
                .copy("yt-dlp-version.txt"),
                .copy("_internal"),
                .copy("deno"),
                .copy("ffmpeg"),
                .copy("aria2c"),
                .copy("aria2-libs"),
                .copy("aria2-cacert.pem"),
                .copy("aria2-version.txt"),
                .copy("aria2-licenses")
            ]
        )
    ]
)
