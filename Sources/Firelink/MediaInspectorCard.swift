import SwiftUI

struct MediaInspectorCard: View {
    let url: URL
    let cookieSource: BrowserCookieSource
    let credentials: DownloadCredentials?
    let transferOptions: DownloadTransferOptions
    let onDownload: (CleanFormatOption, MediaMetadata) -> Void

    @ObservedObject private var engineManager = MediaEngineManager.shared

    @State private var isLoading = true
    @State private var statusText = "Checking Media Engine..."
    @State private var metadata: MediaMetadata?
    @State private var options: [CleanFormatOption] = []
    @State private var selectedOptionID: String?
    @State private var errorMessage: String?
    @State private var loadTask: Task<Void, Never>?

    var body: some View {
        ZStack {
            // Blurred Background
            if let thumbnail = metadata?.thumbnail {
                AsyncImage(url: thumbnail) { image in
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .blur(radius: 40)
                        .scaleEffect(1.2)
                        .opacity(0.4)
                } placeholder: {
                    Color.clear
                }
            }

            Rectangle()
                .fill(.ultraThinMaterial)

            VStack(spacing: 24) {
                if isLoading {
                    VStack(spacing: 16) {
                        ProgressView()
                            .controlSize(.large)

                        let ytState = engineManager.ytDlpState
                        let ffState = engineManager.ffmpegState

                        if case let .downloading(p) = ytState, p > 0 {
                            Text("Downloading yt-dlp: \(Int(p * 100))%")
                                .font(.headline)
                                .foregroundStyle(.secondary)
                        } else if case let .downloading(p) = ffState, p > 0 {
                            Text("Downloading ffmpeg: \(Int(p * 100))%")
                                .font(.headline)
                                .foregroundStyle(.secondary)
                        } else {
                            Text(statusText)
                                .font(.headline)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorMessage {
                    VStack(spacing: 16) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 40))
                            .foregroundStyle(.orange)
                        Text("Extraction Failed")
                            .font(.headline)
                        Text(errorMessage)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)

                        Button("Retry") {
                            loadMetadata()
                        }
                        .buttonStyle(.bordered)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let metadata {
                    contentView(metadata: metadata)
                }
            }
            .padding(24)
        }
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(.quaternary, lineWidth: 1)
        )
        .onAppear {
            loadMetadata()
        }
        .onDisappear {
            loadTask?.cancel()
            loadTask = nil
        }
    }

    @ViewBuilder
    private func contentView(metadata: MediaMetadata) -> some View {
        VStack(spacing: 20) {
            // Header Info
            HStack(alignment: .top, spacing: 16) {
                if let thumbnail = metadata.thumbnail {
                    AsyncImage(url: thumbnail) { image in
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .frame(width: 140, height: 90)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .shadow(color: .black.opacity(0.2), radius: 4, y: 2)
                    } placeholder: {
                        RoundedRectangle(cornerRadius: 8)
                            .fill(.quaternary)
                            .frame(width: 140, height: 90)
                    }
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text(metadata.title ?? "Unknown Title")
                        .font(.headline)
                        .lineLimit(2)

                    if let uploader = metadata.displayUploader {
                        Text(uploader)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }

                    if let duration = metadata.duration {
                        Text(formatDuration(duration))
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }
                }
                Spacer()
            }

            Divider()

            // Format Picker
            VStack(alignment: .leading, spacing: 12) {
                Text("Select Format")
                    .font(.subheadline.weight(.semibold))

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(options) { option in
                            formatCard(for: option)
                        }
                    }
                    .padding(.bottom, 4) // For shadow
                }
            }

            Spacer()

            // Action
            Button {
                if let selected = options.first(where: { $0.id == selectedOptionID }) {
                    onDownload(selected, metadata)
                }
            } label: {
                Text("Download")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(selectedOptionID == nil)
        }
    }

    @ViewBuilder
    private func formatCard(for option: CleanFormatOption) -> some View {
        let isSelected = selectedOptionID == option.id

        Button {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) {
                selectedOptionID = option.id
            }
        } label: {
            VStack(spacing: 8) {
                Image(systemName: option.symbol)
                    .font(.system(size: 24))
                    .foregroundStyle(isSelected ? .white : .accentColor)

                Text(option.name)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(isSelected ? .white : .primary)
            }
            .frame(width: 100, height: 80)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(isSelected ? Color.accentColor : Color(NSColor.controlBackgroundColor))
                    .shadow(color: isSelected ? .accentColor.opacity(0.3) : .black.opacity(0.1), radius: isSelected ? 8 : 2, y: 2)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(isSelected ? AnyShapeStyle(Color.clear) : AnyShapeStyle(.quaternary), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .scaleEffect(isSelected ? 1.05 : 1.0)
    }

    private func loadMetadata() {
        loadTask?.cancel()
        isLoading = true
        errorMessage = nil

        loadTask = Task {
            do {
                await MainActor.run {
                    statusText = "Checking Media Engine..."
                }
                try await MediaEngineManager.shared.ensureInstalled()
                guard !Task.isCancelled else { return }

                await MainActor.run {
                    statusText = "Fetching Metadata..."
                }
                let (fetchedMetadata, fetchedOptions) = try await MediaExtractionEngine.fetchMetadata(
                    for: url,
                    cookieSource: cookieSource,
                    credentials: credentials,
                    transferOptions: transferOptions
                )
                guard !Task.isCancelled else { return }

                await MainActor.run {
                    self.metadata = fetchedMetadata
                    self.options = fetchedOptions
                    self.selectedOptionID = fetchedOptions.first?.id
                    self.loadTask = nil
                    withAnimation {
                        self.isLoading = false
                    }
                }
            } catch {
                await MainActor.run {
                    self.errorMessage = error.localizedDescription
                    self.loadTask = nil
                    withAnimation {
                        self.isLoading = false
                    }
                }
            }
        }
    }

    private func formatDuration(_ duration: Double) -> String {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = duration > 3600 ? [.hour, .minute, .second] : [.minute, .second]
        formatter.unitsStyle = .positional
        formatter.zeroFormattingBehavior = .pad
        return formatter.string(from: duration) ?? ""
    }
}
