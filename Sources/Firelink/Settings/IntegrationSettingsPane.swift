import AppKit
import SwiftUI

struct IntegrationSettingsPane: View {
    @EnvironmentObject private var controller: DownloadController

    var body: some View {
        Form {
            Section {
                HStack(alignment: .center, spacing: 14) {
                    Image(systemName: "puzzlepiece.extension")
                        .resizable()
                        .frame(width: 48, height: 48)
                        .foregroundStyle(.orange)
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Firefox Extension")
                            .font(.title2.weight(.semibold))
                        Text("Capture downloads directly from your browser.")
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }

            Section("Installation") {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Firelink Companion is officially available on the Mozilla Add-on store. Install it to easily intercept downloads and send media directly to Firelink.")
                        .foregroundStyle(.secondary)

                    Button {
                        if let url = URL(string: "https://addons.mozilla.org/en-US/firefox/addon/firelink-companion/") {
                            NSWorkspace.shared.open(url)
                        }
                    } label: {
                        Label("Install on Firefox", systemImage: "arrow.down.app")
                            .font(.headline)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 4)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color(nsColor: NSColor(red: 1.0, green: 0.44, blue: 0.22, alpha: 1.0))) // Firefox Orange
                    .controlSize(.large)
                }
                .padding(.vertical, 8)
            }

            Section("Diagnostics") {
                LabeledContent("Local receiver") {
                    if let port = controller.extensionServerPort {
                        Label("Listening on 127.0.0.1:\(port)", systemImage: "checkmark.seal.fill")
                            .foregroundStyle(.green)
                    } else {
                        Label("Not listening", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }
            }

            Section("Permissions & Privacy") {
                Text("The Firelink extension uses download, context menu, storage, active tab, scripting, and local Firelink endpoint permissions. It reads the active tab URL for per-site settings and explicit right-click actions, and forwards download URLs only when you use a Firelink action or enable global capture.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}
