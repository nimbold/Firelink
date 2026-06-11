import AppKit
import SwiftUI

struct AboutSettingsPane: View {
    @EnvironmentObject private var updateChecker: ReleaseUpdateChecker

    private let projectURL = URL(string: "https://github.com/nimbold/Firelink")!
    private let releasesURL = URL(string: "https://github.com/nimbold/Firelink/releases")!
    private let aria2URL = URL(string: "https://aria2.github.io/")!
    private let ytDlpURL = URL(string: "https://github.com/yt-dlp/yt-dlp")!
    private let ffmpegURL = URL(string: "https://ffmpeg.org/")!
    private let denoURL = URL(string: "https://deno.com/")!
    private let licenseURL = URL(string: "https://github.com/nimbold/Firelink/blob/main/LICENSE")!

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0"
    }


    var body: some View {
        Form {
            Section {
                HStack(alignment: .center, spacing: 16) {
                    Image(nsImage: NSApp.applicationIconImage)
                        .resizable()
                        .frame(width: 64, height: 64)
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Firelink")
                            .font(.title2.weight(.bold))
                        Text("Version \(appVersion)")
                            .foregroundStyle(.secondary)
                        Text("A native macOS download manager for fast, organized, segmented transfers.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 8)
            }

            Section("Updates") {
                VStack(alignment: .leading, spacing: 16) {
                    updateStatusView

                    Divider()
                        .padding(.vertical, 2)

                    Toggle("Automatically check for updates", isOn: $updateChecker.automaticallyChecksForUpdates)
                }
                .padding(.vertical, 8)
                .animation(.easeInOut, value: updateChecker.state)
            }

            Section {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("Created by NimBold")
                        Spacer()
                        Link(destination: projectURL) {
                            HStack(spacing: 4) {
                                if let imgPath = Bundle.main.path(forResource: "GitHubTemplate", ofType: "png"),
                                   let nsImage = NSImage(contentsOfFile: imgPath) {
                                    Image(nsImage: nsImage)
                                        .resizable()
                                        .renderingMode(.template)
                                        .frame(width: 14, height: 14)
                                        .foregroundStyle(.secondary)
                                }
                                Text("Source Code")
                            }
                        }
                        .buttonStyle(.plain)
                    }

                    HStack {
                        Text("Powered by")
                        HStack(spacing: 4) {
                            Link("aria2", destination: aria2URL)
                            Text("•").foregroundStyle(.secondary)
                            Link("yt-dlp", destination: ytDlpURL)
                            Text("•").foregroundStyle(.secondary)
                            Link("ffmpeg", destination: ffmpegURL)
                            Text("•").foregroundStyle(.secondary)
                            Link("Deno", destination: denoURL)
                        }
                        Spacer()
                        Link("MIT License", destination: licenseURL)
                    }

                    Text("Copyright © 2026 NimBold. All rights reserved.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .font(.caption)
                .padding(.vertical, 4)
            }
        }
        .formStyle(.grouped)
    }

    @ViewBuilder
    private var updateStatusView: some View {
        HStack(alignment: .center) {
            switch updateChecker.state {
            case .idle:
                VStack(alignment: .leading, spacing: 2) {
                    Text("Check for Updates")
                        .font(.headline)
                    Text("Firelink checks GitHub Releases for new versions.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Check Now") {
                    updateChecker.checkForUpdates()
                }

            case .checking:
                VStack(alignment: .leading, spacing: 2) {
                    Text("Checking for updates...")
                        .font(.headline)
                    Text("Connecting to GitHub...")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                ProgressView()
                    .controlSize(.small)
                    .padding(.trailing, 16)

            case .updateAvailable(let update):
                VStack(alignment: .leading, spacing: 2) {
                    Text("Firelink \(update.version) is available!")
                        .font(.headline)
                    Text("You currently have version \(appVersion).")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    
                    Link("View Release Notes", destination: update.releaseURL)
                        .font(.caption)
                        .padding(.top, 2)
                }
                Spacer()
                Button("Download Update") {
                    NSWorkspace.shared.open(update.releaseURL)
                }
                .buttonStyle(.borderedProminent)

            case .upToDate(let latestVersion, _):
                Image(systemName: "checkmark.seal.fill")
                    .font(.title2)
                    .foregroundStyle(.green)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Firelink is up to date")
                        .font(.headline)
                    Text("Version \(latestVersion) is the newest stable release.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Check Again") {
                    updateChecker.checkForUpdates()
                }

            case .failed(let message, let recovery):
                VStack(alignment: .leading, spacing: 2) {
                    Text(message)
                        .font(.headline)
                    Text(recovery)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer()
                Button("Try Again") {
                    updateChecker.checkForUpdates()
                }
            }
        }
        .padding(.vertical, 4)
    }

}
