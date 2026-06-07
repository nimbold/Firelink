import SwiftUI
import AppKit

struct EngineSettingsPane: View {
    @EnvironmentObject private var settings: AppSettings
    @StateObject private var engineManager = MediaEngineManager.shared
    @State private var version = "Checking..."

    @State private var isCheckingForUpdates = false
    @State private var updateCheckResult: String?

    private var executableURL: URL? {
        Aria2DownloadEngine.findExecutable()
    }

    var body: some View {
        Form {
            Section("Aria2 (HTTP/FTP)") {
                LabeledContent("Status") {
                    Label(
                        executableURL == nil ? "Missing" : "Ready",
                        systemImage: executableURL == nil ? "exclamationmark.triangle.fill" : "checkmark.seal.fill"
                    )
                    .foregroundStyle(executableURL == nil ? .orange : .green)
                }

                LabeledContent("Binary") {
                    Text(executableURL?.path ?? "Not found")
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                }

                LabeledContent("Version") {
                    Text(version)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                }

                if executableURL == nil {
                    Text("Install aria2 with Homebrew or bundle aria2c inside the app resources.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section("Media Engine (yt-dlp & ffmpeg)") {
                addonStatusRow(title: "yt-dlp", state: engineManager.ytDlpState)
                addonStatusRow(title: "ffmpeg", state: engineManager.ffmpegState)

                HStack(spacing: 12) {
                    Button("Check for Updates") {
                        Task {
                            isCheckingForUpdates = true
                            updateCheckResult = nil
                            try? await Task.sleep(nanoseconds: 800_000_000)

                            do {
                                try await engineManager.ensureInstalled()
                                updateCheckResult = "Up to date."
                            } catch {
                                updateCheckResult = "Update failed."
                            }

                            isCheckingForUpdates = false
                            try? await Task.sleep(nanoseconds: 3_000_000_000)
                            if !isCheckingForUpdates {
                                updateCheckResult = nil
                            }
                        }
                    }
                    .disabled(isDownloadingMediaEngines || isCheckingForUpdates)

                    if isCheckingForUpdates {
                        ProgressView().controlSize(.small)
                        Text("Checking...")
                            .foregroundStyle(.secondary)
                            .font(.subheadline)
                    } else if let result = updateCheckResult {
                        Text(result)
                            .foregroundStyle(.secondary)
                            .font(.subheadline)
                    }

                    Spacer()
                }

                Picker("Browser Cookies", selection: $settings.mediaCookieSource) {
                    ForEach(BrowserCookieSource.allCases, id: \.self) { source in
                        Text(source.rawValue).tag(source)
                    }
                }

                LabeledContent("Cookie Status") {
                    if settings.mediaCookieSource == .none {
                        Label(settings.mediaCookieSource.statusTitle, systemImage: "circle")
                            .foregroundStyle(.secondary)
                    } else {
                        Label(settings.mediaCookieSource.statusTitle, systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                }

                Text(settings.mediaCookieSource.statusDetail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .task {
            version = await Aria2DownloadEngine.versionString() ?? "Unavailable"
        }
    }

    private var isDownloadingMediaEngines: Bool {
        if case .downloading = engineManager.ytDlpState { return true }
        if case .downloading = engineManager.ffmpegState { return true }
        return false
    }

    @ViewBuilder
    private func addonStatusRow(title: String, state: AddonState) -> some View {
        LabeledContent(title) {
            switch state {
            case .notInstalled:
                Label("Missing", systemImage: "xmark.circle.fill")
                    .foregroundStyle(.orange)
            case .downloading(let progress):
                HStack(spacing: 6) {
                    ProgressView(value: progress)
                        .frame(width: 60)
                    Text("\(Int(progress * 100))%")
                        .monospacedDigit()
                }
            case .installed(let version):
                Label("v\(version)", systemImage: "checkmark.seal.fill")
                    .foregroundStyle(.green)
                    .font(.system(.body, design: .monospaced))
            case .failed(let error):
                Label("Failed: \(error)", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
            }
        }
    }
}
