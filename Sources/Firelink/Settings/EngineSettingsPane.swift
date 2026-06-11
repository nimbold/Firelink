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

                LabeledContent("Binary") {
                    if let url = executableURL {
                        Button("Reveal in Finder") {
                            NSWorkspace.shared.selectFile(url.path, inFileViewerRootedAtPath: "")
                        }
                    } else {
                        Text("Not found")
                            .foregroundStyle(.red)
                    }
                }
            } header: {
                Text("Core Downloader (Aria2)")
            } footer: {
                if executableURL == nil {
                    Text("The bundled aria2 runtime is missing. Reinstall Firelink or rebuild its media engines.")
                        .foregroundStyle(.red)
                } else {
                    Text("Handles core HTTP/FTP and BitTorrent downloads.")
                }
            }

            Section {
                addonStatusRow(title: "yt-dlp", state: engineManager.ytDlpState, path: engineManager.binaryPath(for: .ytDlp))

                addonStatusRow(title: "FFmpeg", state: engineManager.ffmpegState, path: engineManager.binaryPath(for: .ffmpeg))

                addonStatusRow(title: "Deno", state: engineManager.denoState, path: engineManager.binaryPath(for: .deno))

                LabeledContent("Browser Cookies") {
                    HStack {
                        Spacer()
                        Picker("", selection: $settings.mediaCookieSource) {
                            ForEach(BrowserCookieSource.allCases, id: \.self) { source in
                                Text(source.rawValue).tag(source)
                            }
                        }
                        .labelsHidden()
                        .fixedSize()
                    }
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
            HStack(spacing: 8) {
                switch state {
                case .notInstalled:
                    Text("Missing")
                        .foregroundStyle(.red)
                case .installed(let version):
                    Text(version)
                        .foregroundStyle(.secondary)
                        .font(.system(.body, design: .monospaced))
                case .failed(let error):
                    Text("Error")
                        .foregroundStyle(.red)
                        .help(error)
                }
                
                if let path {
                    Button("Reveal") {
                        NSWorkspace.shared.selectFile(path.path, inFileViewerRootedAtPath: "")
                    }
                }
            }
        }
    }
}
