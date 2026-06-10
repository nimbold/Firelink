import SwiftUI

struct DownloadSettingsPane: View {
    @EnvironmentObject private var settings: AppSettings

    var body: some View {
        Form {
            Section {
                LabeledContent {
                    Stepper("\(settings.perServerConnections)", value: $settings.perServerConnections, in: 1...16)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Default connections:")
                        Text("For new downloads")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                LabeledContent {
                    Stepper("\(settings.maxConcurrentDownloads)", value: $settings.maxConcurrentDownloads, in: 1...12)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Parallel downloads:")
                        Text("Max simultaneous active files")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                LabeledContent {
                    HStack {
                        TextField("0", value: $settings.globalSpeedLimitKiBPerSecond, format: .number)
                            .textFieldStyle(.roundedBorder)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 80)
                        Text("KiB/s")
                            .foregroundStyle(.secondary)
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Global speed limit:")
                        Text("0 = unlimited speed")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                LabeledContent {
                    Stepper("\(settings.maxAutomaticRetries)", value: $settings.maxAutomaticRetries, in: 0...10)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Automatic retries:")
                        Text("If a connection fails")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Toggle(isOn: $settings.showNotifications) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Show notification when download completes")
                        Text("Alerts you in Notification Center")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Toggle(isOn: $settings.playCompletionSound) {
                    Text("Play sound when download completes")
                }
                .disabled(!settings.showNotifications)
            }
        }
        .formStyle(.grouped)
    }
}
