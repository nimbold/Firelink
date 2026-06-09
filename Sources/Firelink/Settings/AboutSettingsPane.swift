import AppKit
import SwiftUI

struct AboutSettingsPane: View {
    @EnvironmentObject private var updateChecker: ReleaseUpdateChecker

    private let projectURL = URL(string: "https://github.com/nimbold/Firelink")!
    private let releasesURL = URL(string: "https://github.com/nimbold/Firelink/releases")!
    private let aria2URL = URL(string: "https://aria2.github.io/")!
    private let ytDlpURL = URL(string: "https://github.com/yt-dlp/yt-dlp")!
    private let ffmpegURL = URL(string: "https://ffmpeg.org/")!
    private let licenseURL = URL(string: "https://github.com/nimbold/Firelink/blob/main/LICENSE")!

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0"
    }

    private var buildNumber: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "Development"
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
                        Text("Version \(appVersion) (\(buildNumber))")
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
        switch updateChecker.state {
        case .idle:
            VStack(alignment: .leading, spacing: 12) {
                updateHeader(
                    systemImage: "arrow.down.circle",
                    tint: .blue,
                    title: "Check for Updates",
                    subtitle: "Firelink checks GitHub Releases and opens the download page when a new version is available."
                )

                HStack(spacing: 12) {
                    Button {
                        updateChecker.checkForUpdates()
                    } label: {
                        Label("Check for Updates", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)

                    Button {
                        NSWorkspace.shared.open(releasesURL)
                    } label: {
                        Label("Release Notes", systemImage: "doc.text")
                    }
                }
            }

        case .checking:
            HStack(spacing: 12) {
                ProgressView()
                    .controlSize(.small)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Checking GitHub Releases")
                        .font(.headline)
                    Text("Looking for the latest stable Firelink release.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }

        case .updateAvailable(let update):
            VStack(alignment: .leading, spacing: 12) {
                updateHeader(
                    systemImage: "arrow.down.circle.fill",
                    tint: .green,
                    title: "Firelink \(update.version) Is Available",
                    subtitle: "You have Firelink \(appVersion). Download the new release from GitHub when you're ready."
                )

                HStack(spacing: 12) {
                    Button {
                        NSWorkspace.shared.open(update.releaseURL)
                    } label: {
                        Label("Open GitHub Release", systemImage: "arrow.up.forward.app")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)

                    Button {
                        updateChecker.checkForUpdates()
                    } label: {
                        Label("Check Again", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                }
            }

        case .upToDate(let latestVersion, let localVersion):
            VStack(alignment: .leading, spacing: 12) {
                let subtitle = latestVersion == localVersion
                    ? "Firelink \(localVersion) is the newest stable release."
                    : "Firelink \(localVersion) is newer than the latest stable GitHub release, \(latestVersion)."

                updateHeader(
                    systemImage: "checkmark.seal.fill",
                    tint: .green,
                    title: "You're Up to Date",
                    subtitle: subtitle
                )

                HStack(spacing: 12) {
                    Button {
                        updateChecker.checkForUpdates()
                    } label: {
                        Label("Check Again", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)

                    Button {
                        NSWorkspace.shared.open(releasesURL)
                    } label: {
                        Label("Release Notes", systemImage: "doc.text")
                    }
                }
            }

        case .failed(let message, let recovery):
            VStack(alignment: .leading, spacing: 12) {
                updateHeader(
                    systemImage: "exclamationmark.triangle.fill",
                    tint: .orange,
                    title: message,
                    subtitle: recovery
                )

                HStack(spacing: 12) {
                    Button {
                        updateChecker.checkForUpdates()
                    } label: {
                        Label("Check Again", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.borderedProminent)

                    Button {
                        NSWorkspace.shared.open(releasesURL)
                    } label: {
                        Label("Open Releases", systemImage: "safari")
                    }
                }
            }
        }
    }

    private func updateHeader(systemImage: String, tint: Color, title: String, subtitle: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .font(.title2)
                .foregroundStyle(tint)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

}
