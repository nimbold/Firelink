import SwiftUI

struct MediaInspectorInlineView: View {
    let url: URL
    let cookieSource: BrowserCookieSource
    let credentials: DownloadCredentials?
    let transferOptions: DownloadTransferOptions
    let onCancel: () -> Void
    let onDownload: (CleanFormatOption, MediaMetadata) -> Void

    @ObservedObject private var engineManager = MediaEngineManager.shared

    @State private var isLoading = true
    @State private var statusText = "Checking Media Engine..."
    @State private var metadata: MediaMetadata?
    @State private var options: [CleanFormatOption] = []
    @State private var errorMessage: String?
    @State private var loadTask: Task<Void, Never>?

    enum MediaType: String, CaseIterable, Identifiable {
        case video = "Video"
        case audio = "Audio"
        var id: String { rawValue }
    }

    @State private var selectedType: MediaType = .video
    @State private var selectedVideoQuality: String = "Best"
    @State private var selectedVideoFormat: String = "MP4"
    @State private var selectedAudioFormat: String = "MP3"

    var body: some View {
        HStack(spacing: 16) {
            if isLoading {
                ProgressView()
                    .controlSize(.regular)

                let ytState = engineManager.ytDlpState
                let ffState = engineManager.ffmpegState

                if case let .downloading(p) = ytState, p > 0 {
                    Text("Downloading yt-dlp: \(Int(p * 100))%")
                        .foregroundStyle(.secondary)
                } else if case let .downloading(p) = ffState, p > 0 {
                    Text("Downloading ffmpeg: \(Int(p * 100))%")
                        .foregroundStyle(.secondary)
                } else {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(statusText)
                            .foregroundStyle(.secondary)
                        cookieStatusLabel
                    }
                }
                Spacer()
            } else if let errorMessage {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                Text(errorMessage)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Spacer()
                Button("Retry") {
                    loadMetadata()
                }
            } else if let metadata {
                if let thumbnail = metadata.thumbnail {
                    AsyncImage(url: thumbnail) { image in
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .frame(width: 80, height: 50)
                            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                            .shadow(color: .black.opacity(0.1), radius: 2, y: 1)
                    } placeholder: {
                        RoundedRectangle(cornerRadius: 6)
                            .fill(.quaternary)
                            .frame(width: 80, height: 50)
                    }
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text(metadata.title ?? "Unknown Title")
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)

                    HStack(spacing: 12) {
                        Picker("Type", selection: $selectedType) {
                            ForEach(availableTypes) { type in
                                Text(type.rawValue).tag(type)
                            }
                        }
                        .labelsHidden()
                        .frame(width: 80)

                        if selectedType == .video {
                            Picker("Quality", selection: $selectedVideoQuality) {
                                ForEach(availableVideoQualities, id: \.self) { q in
                                    Text(q).tag(q)
                                }
                            }
                            .labelsHidden()
                            .frame(width: 90)

                            Picker("Format", selection: $selectedVideoFormat) {
                                ForEach(availableVideoFormats, id: \.self) { f in
                                    Text(f).tag(f)
                                }
                            }
                            .labelsHidden()
                            .frame(width: 80)
                        } else {
                            Picker("Format", selection: $selectedAudioFormat) {
                                ForEach(availableAudioFormats, id: \.self) { f in
                                    Text(f).tag(f)
                                }
                            }
                            .labelsHidden()
                            .frame(width: 90)
                        }
                    }

                    if let selected = resolveSelectedOption() {
                        Text(selected.detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: 16)

                Button("Cancel") {
                    onCancel()
                }
                .keyboardShortcut(.cancelAction)

                Button("Extract") {
                    if let selected = resolveSelectedOption() {
                        onDownload(selected, metadata)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(resolveSelectedOption() == nil)
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(.quaternary.opacity(0.35))
        )
        .onAppear {
            loadMetadata()
        }
        .onDisappear {
            loadTask?.cancel()
            loadTask = nil
        }
        .onChange(of: url) { _, _ in loadMetadata() }
        .onChange(of: cookieSource) { _, _ in loadMetadata() }
        .onChange(of: credentials) { _, _ in loadMetadata() }
        .onChange(of: transferOptions) { _, _ in loadMetadata() }
        .onChange(of: selectedType) { _, _ in ensureValidSelection() }
        .onChange(of: options) { _, _ in ensureValidSelection() }
    }

    private var availableTypes: [MediaType] {
        var types: [MediaType] = []
        if options.contains(where: { !$0.isAudioOnly }) { types.append(.video) }
        if options.contains(where: { $0.isAudioOnly }) { types.append(.audio) }
        return types
    }

    private var availableVideoQualities: [String] {
        let qualities = options.filter { !$0.isAudioOnly }.map { $0.name.components(separatedBy: " ").first ?? "" }
        return NSOrderedSet(array: qualities).array as? [String] ?? []
    }

    private var availableVideoFormats: [String] {
        let formats = options.filter { !$0.isAudioOnly }.map { $0.name.components(separatedBy: " ").last ?? "" }
        return NSOrderedSet(array: formats).array as? [String] ?? []
    }

    private var availableAudioFormats: [String] {
        let formats = options.filter { $0.isAudioOnly }.map { $0.name.replacingOccurrences(of: "Audio ", with: "") }
        return NSOrderedSet(array: formats).array as? [String] ?? []
    }

    private func ensureValidSelection() {
        if !availableTypes.contains(selectedType), let first = availableTypes.first {
            selectedType = first
        }
        if selectedType == .video {
            if !availableVideoQualities.contains(selectedVideoQuality), let first = availableVideoQualities.first {
                selectedVideoQuality = first
            }
            if !availableVideoFormats.contains(selectedVideoFormat), let first = availableVideoFormats.first {
                selectedVideoFormat = first
            }
        } else {
            if !availableAudioFormats.contains(selectedAudioFormat), let first = availableAudioFormats.first {
                selectedAudioFormat = first
            }
        }
    }

    private func resolveSelectedOption() -> CleanFormatOption? {
        if selectedType == .video {
            return options.first { !$0.isAudioOnly && $0.name == "\(selectedVideoQuality) \(selectedVideoFormat)" }
        } else {
            return options.first { $0.isAudioOnly && $0.name == "Audio \(selectedAudioFormat)" }
        }
    }

    @ViewBuilder
    private var cookieStatusLabel: some View {
        if let browserName = cookieSource.ytDlpBrowserName {
            Label("Using \(browserName.capitalized) cookies", systemImage: "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(.green)
        } else {
            Label("Browser cookies off", systemImage: "circle")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func loadMetadata() {
        loadTask?.cancel()
        isLoading = true
        errorMessage = nil
        metadata = nil
        options = []

        loadTask = Task {
            do {
                await MainActor.run { statusText = "Checking yt-dlp..." }
                try await MediaEngineManager.shared.ensureAvailable(addons: [.ytDlp])
                guard !Task.isCancelled else { return }

                await MainActor.run { statusText = "Fetching Metadata..." }
                let (fetchedMetadata, fetchedOptions) = try await MediaExtractionEngine.fetchMetadata(
                    for: url,
                    cookieSource: cookieSource,
                    credentials: credentials,
                    transferOptions: transferOptions
                )
                guard !Task.isCancelled else { return }

                await MainActor.run {
                    if fetchedOptions.isEmpty {
                        self.errorMessage = "No downloadable media formats were found."
                    } else {
                        self.metadata = fetchedMetadata
                        self.options = fetchedOptions
                        self.ensureValidSelection()
                    }
                    self.loadTask = nil
                    withAnimation { self.isLoading = false }
                }
            } catch {
                await MainActor.run {
                    self.errorMessage = error.localizedDescription
                    self.loadTask = nil
                    withAnimation { self.isLoading = false }
                }
            }
        }
    }
}
