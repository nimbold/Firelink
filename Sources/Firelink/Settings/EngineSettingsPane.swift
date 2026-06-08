import SwiftUI
import AppKit

struct EngineSettingsPane: View {
    @EnvironmentObject private var settings: AppSettings
    @StateObject private var engineManager = MediaEngineManager.shared
    @State private var version = "Checking..."

    private var executableURL: URL? {
        Aria2DownloadEngine.findExecutable()
    }

    var body: some View {
        Form {
            Section {
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
                addonStatusRow(title: "yt-dlp", state: engineManager.ytDlpState, path: engineManager.binaryPath(for: .ytDlp))
                
                addonStatusRow(title: "FFmpeg", state: engineManager.ffmpegState, path: engineManager.binaryPath(for: .ffmpeg))
                
                LabeledContent("Browser Cookies") {
                    Picker("", selection: $settings.mediaCookieSource) {
                        ForEach(BrowserCookieSource.allCases, id: \.self) { source in
                            Text(source.rawValue).tag(source)
                        }
                    }
                    .labelsHidden()
                    .frame(maxWidth: 200)
                }
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

    @ViewBuilder
    private func addonStatusRow(title: String, state: AddonState, path: URL?) -> some View {
        LabeledContent(title) {
            VStack(alignment: .trailing) {
                switch state {
                case .notInstalled:
                    Text("Missing")
                        .foregroundStyle(.red)
                case .downloading:
                    Text("Unavailable")
                case .installed(let version):
                    Text(version)
                        .foregroundStyle(.secondary)
                        .font(.system(.body, design: .monospaced))
                case .failed(let error):
                    Text("Error")
                        .foregroundStyle(.red)
                        .help(error)
                }
                
                Text(path?.path ?? "Not found")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }
        }
    }
}
