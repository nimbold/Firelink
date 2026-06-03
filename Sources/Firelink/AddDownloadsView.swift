import SwiftUI

struct AddDownloadsView: View {
    @EnvironmentObject private var controller: DownloadController
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.dismiss) private var dismiss

    @State private var linkText = ""
    @State private var pendingDownloads: [PendingDownload] = []
    @State private var connectionsPerServer = 16.0
    @State private var overrideDestination = false
    @State private var destinationPath = ""
    @State private var metadataTask: Task<Void, Never>?
    @State private var targetQueueID = DownloadQueue.mainQueueID
    @State private var showsAdvancedTransfer = false
    @State private var checksumEnabled = false
    @State private var checksumAlgorithm: ChecksumAlgorithm = .sha256
    @State private var checksumValue = ""
    @State private var headerText = ""
    @State private var cookieText = ""
    @State private var mirrorText = ""

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    linkSection
                    optionsSection
                    advancedTransferSection
                    summarySection
                    previewSection
                }
                .padding(20)
            }

            Divider()
            actionBar
        }
        .frame(minWidth: 820, idealWidth: 900, minHeight: 680, idealHeight: 740)
        .onChange(of: linkText) { _, newValue in
            scheduleMetadataRefresh(for: newValue)
        }
        .onAppear {
            connectionsPerServer = Double(settings.perServerConnections)
            targetQueueID = controller.pendingAddQueueID ?? DownloadQueue.mainQueueID
            controller.pendingAddQueueID = nil
            if let text = controller.pendingPasteboardText {
                linkText = text
                controller.pendingPasteboardText = nil
            }
        }
        .onDisappear {
            metadataTask?.cancel()
        }
    }

    private var linkSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Download Links", systemImage: "link")
                .font(.headline)

            TextEditor(text: $linkText)
                .font(.system(.body, design: .monospaced))
                .scrollContentBackground(.hidden)
                .background(.quaternary.opacity(0.35))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .frame(minHeight: 140)

            HStack {
                Text("\(pendingDownloads.count) valid link\(pendingDownloads.count == 1 ? "" : "s") detected")
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    refreshMetadata(for: linkText)
                } label: {
                    Label("Refresh Metadata", systemImage: "arrow.clockwise")
                }
                .disabled(DownloadURLParser.parse(linkText).isEmpty)
            }
            .font(.caption)
        }
    }

    private var optionsSection: some View {
        Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 12) {
            GridRow {
                Label("Save Location", systemImage: "folder")
                    .font(.headline)
                Toggle("Use one folder for all files", isOn: $overrideDestination)
            }

            GridRow {
                Text("")
                HStack(spacing: 10) {
                    TextField("Automatic by file type", text: $destinationPath)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.body, design: .monospaced))
                        .disabled(!overrideDestination)

                    Button {
                        selectDestination()
                    } label: {
                        Label("Select", systemImage: "folder.badge.plus")
                    }
                    .disabled(!overrideDestination)
                }
            }

            GridRow(alignment: .firstTextBaseline) {
                Label("Connections per File", systemImage: "point.3.connected.trianglepath.dotted")
                    .font(.headline)
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Slider(value: $connectionsPerServer, in: 1...16, step: 1)
                            .frame(width: 220)
                        Text("\(Int(connectionsPerServer)) segments")
                            .monospacedDigit()
                            .frame(width: 130, alignment: .leading)
                    }
                    Text("Firelink splits each file into this many parallel segments. This also sets the number of concurrent connections to the server.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var summarySection: some View {
        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 10) {
            GridRow {
                SummaryTile(title: "Files", value: "\(pendingDownloads.count)", symbolName: "doc.on.doc")
                SummaryTile(title: "Required", value: requiredSpaceText, symbolName: "externaldrive")
                SummaryTile(title: "Free", value: freeSpaceText, symbolName: "internaldrive")
                SummaryTile(title: "Unknown Sizes", value: "\(unknownSizeCount)", symbolName: "questionmark.circle")
            }
        }
    }

    private var previewSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Preview", systemImage: "list.bullet.rectangle")
                .font(.headline)

            Table(pendingDownloads) {
                TableColumn("File") { item in
                    HStack {
                        Image(systemName: item.category.symbolName)
                            .foregroundStyle(categoryColor(item.category))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.fileName)
                                .lineLimit(1)
                            Text(item.url.absoluteString)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }

                TableColumn("Size") { item in
                    Text(ByteFormatter.string(item.sizeBytes))
                        .monospacedDigit()
                }
                .width(95)

                TableColumn("Save To") { item in
                    Text(destinationDirectory(for: item).path)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                TableColumn("Status") { item in
                    MetadataStatusView(state: item.state)
                }
                .width(130)
            }
            .frame(minHeight: 230)
        }
    }

    private var actionBar: some View {
        HStack {
            Text(actionMessage)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer()
            Button("Cancel") {
                dismiss()
            }
            Button {
                addDownloads(start: false)
            } label: {
                Label("Add to Queue", systemImage: "list.bullet")
            }
            .disabled(!canAddDownloads)

            Button {
                addDownloads(start: true)
            } label: {
                Label("Start Downloads", systemImage: "play.fill")
            }
            .buttonStyle(.borderedProminent)
            .disabled(!canAddDownloads)
        }
        .padding(14)
        .background(.bar)
    }

    private var advancedTransferSection: some View {
        DisclosureGroup(isExpanded: $showsAdvancedTransfer) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 12) {
                GridRow(alignment: .firstTextBaseline) {
                    Toggle("Checksum", isOn: $checksumEnabled)
                        .font(.headline)
                    HStack(spacing: 10) {
                        Picker("Algorithm", selection: $checksumAlgorithm) {
                            ForEach(ChecksumAlgorithm.allCases) { algorithm in
                                Text(algorithm.title).tag(algorithm)
                            }
                        }
                        .labelsHidden()
                        .frame(width: 130)

                        TextField("Expected digest", text: $checksumValue)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.body, design: .monospaced))
                    }
                    .disabled(!checksumEnabled)
                }

                GridRow(alignment: .top) {
                    Label("Headers", systemImage: "text.quote")
                        .font(.headline)
                    TextEditor(text: $headerText)
                        .font(.system(.body, design: .monospaced))
                        .scrollContentBackground(.hidden)
                        .background(.quaternary.opacity(0.35))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .frame(minHeight: 74)
                }

                GridRow(alignment: .firstTextBaseline) {
                    Label("Cookies", systemImage: "circle.hexagongrid.circle")
                        .font(.headline)
                    TextField("name=value; other=value", text: $cookieText)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.body, design: .monospaced))
                }

                GridRow(alignment: .top) {
                    Label("Mirrors", systemImage: "point.3.filled.connected.trianglepath.dotted")
                        .font(.headline)
                    TextEditor(text: $mirrorText)
                        .font(.system(.body, design: .monospaced))
                        .scrollContentBackground(.hidden)
                        .background(.quaternary.opacity(0.35))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .frame(minHeight: 74)
                }
            }
            .padding(.top, 10)
        } label: {
            Label("Advanced Transfer", systemImage: "slider.horizontal.3")
                .font(.headline)
        }
    }

    private var requiredSpaceText: String {
        let knownBytes = pendingDownloads.compactMap(\.sizeBytes).reduce(Int64(0), +)
        guard knownBytes > 0 else { return "Unknown" }
        return ByteFormatter.string(knownBytes)
    }

    private var unknownSizeCount: Int {
        pendingDownloads.filter { $0.sizeBytes == nil }.count
    }

    private var freeSpaceText: String {
        guard let bytes = availableCapacity() else { return "Unknown" }
        return ByteFormatter.string(bytes)
    }

    private var actionMessage: String {
        if pendingDownloads.isEmpty {
            return "Paste one or more HTTP, HTTPS, FTP, or SFTP links."
        }

        if let validationMessage {
            return validationMessage
        }

        if unknownSizeCount > 0 {
            return "Some servers did not report file size before download."
        }

        return "Ready to add \(pendingDownloads.count) download\(pendingDownloads.count == 1 ? "" : "s")."
    }

    private var canAddDownloads: Bool {
        !pendingDownloads.isEmpty && validationMessage == nil
    }

    private var validationMessage: String? {
        if checksumEnabled && checksumValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Add the expected checksum digest, or turn checksum off."
        }

        if DownloadTransferOptionParser.invalidHeaderLines(headerText).isEmpty == false {
            return "Headers must use Name: Value lines."
        }

        if DownloadTransferOptionParser.invalidMirrorLines(mirrorText).isEmpty == false {
            return "Mirrors must be valid HTTP, HTTPS, FTP, or SFTP URLs."
        }

        return nil
    }

    private var transferOptions: DownloadTransferOptions {
        DownloadTransferOptions(
            checksum: checksumEnabled ? DownloadChecksum(algorithm: checksumAlgorithm, value: checksumValue).normalized : nil,
            requestHeaders: DownloadTransferOptionParser.parseHeaders(headerText),
            cookieHeader: DownloadTransferOptionParser.cleanCookieHeader(cookieText),
            mirrorURLs: DownloadTransferOptionParser.parseMirrorURLs(mirrorText)
        )
    }

    private func scheduleMetadataRefresh(for text: String) {
        metadataTask?.cancel()
        metadataTask = Task {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                refreshMetadata(for: text)
            }
        }
    }

    private func refreshMetadata(for text: String) {
        let urls = DownloadURLParser.parse(text)
        metadataTask?.cancel()

        pendingDownloads = urls.map { url in
            let fileName = FileClassifier.fileName(from: url)
            let category = FileClassifier.category(forFileName: fileName)
            return PendingDownload(
                url: url,
                fileName: fileName,
                category: category,
                defaultDirectory: settings.destinationDirectory(for: category),
                state: .loading
            )
        }

        metadataTask = Task {
            var loaded: [PendingDownload] = []
            for url in urls {
                guard !Task.isCancelled else { return }
                let item = await DownloadMetadataFetcher.fetch(for: url, settings: settings, transferOptions: transferOptions)
                loaded.append(item)
                await MainActor.run {
                    for loadedItem in loaded {
                        if let index = pendingDownloads.firstIndex(where: { $0.url == loadedItem.url }) {
                            pendingDownloads[index] = loadedItem
                        }
                    }
                }
            }
        }
    }

    private func selectDestination() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true

        if let currentURL = overrideDirectory {
            panel.directoryURL = currentURL
        }

        if panel.runModal() == .OK, let url = panel.url {
            destinationPath = url.path
            overrideDestination = true
        }
    }

    private func addDownloads(start: Bool) {
        controller.addPendingDownloads(
            pendingDownloads,
            connectionsPerServer: Int(connectionsPerServer),
            overrideDirectory: overrideDirectory,
            startImmediately: start,
            queueID: targetQueueID,
            transferOptions: transferOptions
        )
        dismiss()
    }

    private var overrideDirectory: URL? {
        guard overrideDestination else { return nil }
        let trimmed = destinationPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return URL(fileURLWithPath: NSString(string: trimmed).expandingTildeInPath, isDirectory: true)
    }

    private func destinationDirectory(for item: PendingDownload) -> URL {
        overrideDirectory ?? item.defaultDirectory
    }

    private func availableCapacity() -> Int64? {
        let urls = pendingDownloads.isEmpty
            ? [settings.destinationDirectory(for: .other)]
            : pendingDownloads.map { destinationDirectory(for: $0) }

        return urls.compactMap { url in
            let values = try? existingVolumeURL(for: url).resourceValues(forKeys: [
                .volumeAvailableCapacityForImportantUsageKey,
                .volumeAvailableCapacityKey
            ])
            if let important = values?.volumeAvailableCapacityForImportantUsage {
                return important
            }
            if let available = values?.volumeAvailableCapacity {
                return Int64(available)
            }
            return nil
        }
        .min()
    }

    private func existingVolumeURL(for url: URL) -> URL {
        var candidate = url
        while !FileManager.default.fileExists(atPath: candidate.path) {
            let parent = candidate.deletingLastPathComponent()
            if parent.path == candidate.path {
                return URL(fileURLWithPath: NSHomeDirectory())
            }
            candidate = parent
        }
        return candidate
    }

    private func categoryColor(_ category: DownloadCategory) -> Color {
        switch category {
        case .musics: .pink
        case .movies: .indigo
        case .compressed: .orange
        case .pictures: .teal
        case .documents: .blue
        case .other: .gray
        }
    }
}

private struct SummaryTile: View {
    let title: String
    let value: String
    let symbolName: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: symbolName)
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.headline.monospacedDigit())
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(width: 190)
        .frame(minHeight: 64)
        .background(.quaternary.opacity(0.35))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

private struct MetadataStatusView: View {
    let state: PendingDownload.MetadataState

    var body: some View {
        switch state {
        case .pending:
            Label("Pending", systemImage: "clock")
                .foregroundStyle(.secondary)
        case .loading:
            HStack {
                ProgressView()
                    .controlSize(.small)
                Text("Checking")
            }
            .foregroundStyle(.secondary)
        case .loaded:
            Label("Ready", systemImage: "checkmark.circle")
                .foregroundStyle(.green)
        case .failed:
            Label("Unknown", systemImage: "exclamationmark.circle")
                .foregroundStyle(.orange)
        }
    }
}
