import AppKit
import SwiftUI

struct AboutSettingsPane: View {
    @EnvironmentObject var sparkleUpdater: SparkleUpdater

    private let developerProfileURL = URL(string: "https://github.com/nimbold")!
    private let projectURL = URL(string: "https://github.com/nimbold/Firelink")!
    private let aria2URL = URL(string: "https://aria2.github.io/")!
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
                VStack(alignment: .leading, spacing: 12) {
                    if let status = sparkleUpdater.updateStatus {
                        HStack {
                            if sparkleUpdater.isChecking {
                                ProgressView()
                                    .controlSize(.small)
                            } else if sparkleUpdater.foundUpdateItem != nil {
                                Image(systemName: "exclamationmark.circle.fill")
                                    .foregroundStyle(.orange)
                            } else {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.green)
                            }
                            Text(status)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }

                    HStack(spacing: 12) {
                        Button {
                            sparkleUpdater.checkForUpdates()
                        } label: {
                            Label("Check for Updates", systemImage: "arrow.clockwise")
                        }
                        .disabled(sparkleUpdater.isChecking)
                        
                        Button {
                            NSWorkspace.shared.open(projectURL.appendingPathComponent("releases"))
                        } label: {
                            Label("Open Releases", systemImage: "arrow.up.right.square")
                        }
                    }
                }
                .padding(.vertical, 4)
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
                        Link("aria2", destination: aria2URL)
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
}
