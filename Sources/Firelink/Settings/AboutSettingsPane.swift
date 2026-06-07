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
                VStack(alignment: .leading, spacing: 16) {
                    if sparkleUpdater.isChecking {
                        HStack(spacing: 12) {
                            ProgressView()
                                .controlSize(.small)
                            Text("Checking for updates...")
                                .foregroundStyle(.secondary)
                        }
                    } else if sparkleUpdater.isDownloading || sparkleUpdater.isExtracting {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(sparkleUpdater.isDownloading ? "Downloading update..." : "Extracting update...")
                                    .font(.subheadline)
                                    .fontWeight(.medium)
                                Spacer()
                                if sparkleUpdater.isDownloading && sparkleUpdater.downloadProgress > 0 {
                                    Text("\(Int(sparkleUpdater.downloadProgress * 100))%")
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(.secondary)
                                }
                            }
                            ProgressView(value: sparkleUpdater.isDownloading ? sparkleUpdater.downloadProgress : sparkleUpdater.extractionProgress)
                                .tint(.accentColor)
                            
                            Button("Cancel") {
                                sparkleUpdater.cancellation?()
                            }
                            .controlSize(.small)
                        }
                    } else if sparkleUpdater.isReadyToInstall {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                Image(systemName: "arrow.down.app.fill")
                                    .foregroundStyle(.green)
                                    .font(.title2)
                                VStack(alignment: .leading) {
                                    Text("Update Ready")
                                        .font(.headline)
                                    Text("The new version is ready to be installed.")
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            
                            Button {
                                sparkleUpdater.updateChoiceReply?(.install)
                            } label: {
                                Label("Install and Relaunch", systemImage: "sparkles")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.large)
                        }
                    } else if let item = sparkleUpdater.foundUpdateItem {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: "exclamationmark.arrow.circlepath")
                                    .foregroundStyle(.orange)
                                    .font(.title)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Update Available")
                                        .font(.headline)
                                    Text("Version \(item.displayVersionString) is available.")
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            
                            if let notes = sparkleUpdater.releaseNotes, !notes.isEmpty {
                                DisclosureGroup("What's New") {
                                    ScrollView {
                                        Text(notes)
                                            .font(.caption)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .textSelection(.enabled)
                                    }
                                    .frame(maxHeight: 150)
                                    .padding(8)
                                    .background(Color(NSColor.controlBackgroundColor))
                                    .cornerRadius(6)
                                }
                            }
                            
                            HStack(spacing: 12) {
                                Button {
                                    sparkleUpdater.updateChoiceReply?(.install)
                                } label: {
                                    Text("Download & Install")
                                }
                                .buttonStyle(.borderedProminent)
                                
                                Button("Skip This Version") {
                                    sparkleUpdater.updateChoiceReply?(.skip)
                                }
                            }
                        }
                    } else {
                        // Up to date or initial state
                        if let status = sparkleUpdater.updateStatus, status == "You're up to date!" {
                            VStack(alignment: .leading, spacing: 12) {
                                HStack(alignment: .top, spacing: 12) {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(.green)
                                        .font(.title)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text("You're up to date!")
                                            .font(.headline)
                                        Text("Firelink \(appVersion) is the newest version available.")
                                            .font(.subheadline)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                
                                HStack(spacing: 12) {
                                    Button {
                                        sparkleUpdater.checkForUpdates()
                                    } label: {
                                        Label("Check Again", systemImage: "arrow.clockwise")
                                    }
                                    .buttonStyle(.bordered)
                                    
                                    Button {
                                        NSWorkspace.shared.open(projectURL.appendingPathComponent("releases"))
                                    } label: {
                                        Label("Release Notes", systemImage: "doc.text")
                                    }
                                }
                            }
                        } else {
                            HStack(spacing: 12) {
                                if let status = sparkleUpdater.updateStatus {
                                    if status.lowercased().contains("failed") || status.lowercased().contains("error") {
                                        Image(systemName: "xmark.octagon.fill")
                                            .foregroundStyle(.red)
                                    } else {
                                        Image(systemName: "info.circle.fill")
                                            .foregroundStyle(.blue)
                                    }
                                    Text(status)
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                } else {
                                    Text("Keeping your app up to date ensures you have the latest features and security improvements.")
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
                                .buttonStyle(.bordered)
                                
                                Button {
                                    NSWorkspace.shared.open(projectURL.appendingPathComponent("releases"))
                                } label: {
                                    Label("Release Notes", systemImage: "doc.text")
                                }
                            }
                        }
                    }
                }
                .padding(.vertical, 8)
                .animation(.easeInOut, value: sparkleUpdater.isChecking)
                .animation(.easeInOut, value: sparkleUpdater.isDownloading)
                .animation(.easeInOut, value: sparkleUpdater.isExtracting)
                .animation(.easeInOut, value: sparkleUpdater.isReadyToInstall)
                .animation(.easeInOut, value: sparkleUpdater.foundUpdateItem != nil)
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
