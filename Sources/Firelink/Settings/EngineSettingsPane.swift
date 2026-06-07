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
            Section {
                LabeledContent("Status") {
                    if executableURL != nil {
                        Label("Ready", systemImage: "checkmark.seal.fill")
                            .foregroundStyle(.green)
                    } else {
                        Label("Missing", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }
                
                LabeledContent("Version") {
                    Text(version)
                        .font(.system(.body, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                
                LabeledContent("Binary Path") {
                    Text(executableURL?.path ?? "Not found")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
                .help(executableURL?.path ?? "")
            } header: {
                Text("Core Downloader (Aria2)")
            } footer: {
                if executableURL == nil {
                    Text("Install aria2 with Homebrew or ensure it is bundled inside the app resources.")
                        .foregroundStyle(.red)
                } else {
                    Text("Handles core HTTP/FTP and BitTorrent downloads.")
                }
            }

            Section {
                LabeledContent("Updates") {
                    HStack(spacing: 8) {
                        Button {
                            checkMediaEngineUpdates()
                        } label: {
                            Text("Check for Updates")
                        }
                        .disabled(isDownloadingMediaEngines || isCheckingForUpdates)

                        if isCheckingForUpdates {
                            ProgressView().controlSize(.small)
                            Text("Checking...")
                                .foregroundStyle(.secondary)
                                .font(.subheadline)
                        } else if let result = updateCheckResult {
                            if result == "Up to date" || result == "Updated successfully" {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.green)
                                Text(result)
                                    .foregroundStyle(.secondary)
                                    .font(.subheadline)
                            } else {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .foregroundStyle(.red)
                                Text(result)
                                    .foregroundStyle(.red)
                                    .font(.subheadline)
                            }
                        }
                    }
                }

                addonStatusRow(title: "yt-dlp", state: engineManager.ytDlpState)
                
                LabeledContent("Browser Cookies") {
                    Picker("", selection: $settings.mediaCookieSource) {
                        ForEach(BrowserCookieSource.allCases, id: \.self) { source in
                            Text(source.rawValue).tag(source)
                        }
                    }
                    .labelsHidden()
                    .frame(maxWidth: 200)
                }
                
                addonStatusRow(title: "FFmpeg", state: engineManager.ffmpegState)
            } header: {
                Text("Media Extractors")
            } footer: {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Powers video and audio extraction from supported sites.")
                    
                    if settings.mediaCookieSource != .none {
                        Text(settings.mediaCookieSource.statusDetail)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .task {
            version = await Aria2DownloadEngine.versionString() ?? "Unavailable"
        }
    }

    private func checkMediaEngineUpdates() {
        Task {
            isCheckingForUpdates = true
            updateCheckResult = nil
            // Brief visual feedback delay
            try? await Task.sleep(nanoseconds: 800_000_000)

            do {
                let wasDownloading = isDownloadingMediaEngines
                try await engineManager.ensureInstalled()
                if wasDownloading || isDownloadingMediaEngines {
                    updateCheckResult = "Updated successfully"
                } else {
                    updateCheckResult = "Up to date"
                }
            } catch {
                updateCheckResult = "Update failed: \(error.localizedDescription)"
            }

            isCheckingForUpdates = false
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if !isCheckingForUpdates {
                withAnimation {
                    updateCheckResult = nil
                }
            }
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
                Label("Failed", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                    .help(error)
            }
        }
    }
}
