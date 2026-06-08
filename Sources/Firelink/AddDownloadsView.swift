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
    @State private var speedLimitEnabled = false
    @State private var speedLimitKiBPerSecond = 1024
    @State private var showsAdvancedTransfer = false
    @State private var checksumEnabled = false
    @State private var checksumAlgorithm: ChecksumAlgorithm = .sha256
    @State private var checksumValue = ""
    @State private var headerText = ""
    @State private var cookieText = ""
    @State private var mirrorText = ""
    @State private var useAuthorization = false
    @State private var authUsername = ""
    @State private var authPassword = ""
    @State private var saveLogin = false

    @State private var conflictingDownloads: [DuplicateDownloadItem] = []
    @State private var showingDuplicates = false
    @State private var pendingStartFlag = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    linkSection


                    optionsSection
                    advancedTransferSection

                    summarySection
                    previewSection
                }
                .padding(12)
            }
            Divider()
            actionBar
                .padding(16)
                .background(.background)
        }
        .frame(minWidth: 640, idealWidth: 680, minHeight: 620, idealHeight: 680)
        .sheet(isPresented: $showingDuplicates) {
            DuplicateResolutionView(
                conflicts: $conflictingDownloads,
                onConfirm: {
                    showingDuplicates = false
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                        executeAddDownloads(start: pendingStartFlag, conflicts: conflictingDownloads)
                    }
                },
                onCancel: {
                    showingDuplicates = false
                }
            )
        }
        .onChange(of: linkText) { _, newValue in
            scheduleMetadataRefresh(for: newValue)
        }
        .onChange(of: metadataRequestSignature) { _, _ in
            guard !DownloadURLParser.parse(linkText).isEmpty else { return }
            scheduleMetadataRefresh(for: linkText)
        }
        .onAppear {
            connectionsPerServer = Double(settings.perServerConnections)
            targetQueueID = controller.pendingAddQueueID ?? DownloadQueue.mainQueueID
            controller.pendingAddQueueID = nil
            if let text = controller.pendingPasteboardText {
                applyPendingReferer()
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
                .font(.subheadline.weight(.semibold))

            TextEditor(text: $linkText)
                .font(.system(.callout, design: .monospaced))
                .scrollContentBackground(.hidden)
                .background(.quaternary.opacity(0.35))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .frame(height: 72)

            HStack {
                Text("\(pendingDownloads.count) valid link\(pendingDownloads.count == 1 ? "" : "s") detected")
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    refreshMetadata(for: linkText, isAutoFetch: false)
                } label: {
                    Label("Refresh Metadata", systemImage: "arrow.clockwise")
                }
                .disabled(DownloadURLParser.parse(linkText).isEmpty)
            }
            .font(.caption)
        }
    }

    private var optionsSection: some View {
        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
            GridRow {
                Label("Save Location", systemImage: "folder")
                    .font(.subheadline.weight(.semibold))
                Toggle("Use one folder for all files", isOn: $overrideDestination)
            }

            GridRow {
                Text("")
                HStack(spacing: 8) {
                    TextField("Automatic by file type", text: $destinationPath)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.callout, design: .monospaced))
                        .disabled(!overrideDestination)

                    Button {
                        selectDestination()
                    } label: {
                        Label("Select...", systemImage: "folder.badge.plus")
                    }
                    .disabled(!overrideDestination)
                }
            }

            GridRow(alignment: .firstTextBaseline) {
                Label("Queue", systemImage: "tray.full")
                    .font(.subheadline.weight(.semibold))
                Picker("Queue", selection: $targetQueueID) {
                    ForEach(controller.queues) { queue in
                        Text(queue.name).tag(queue.id)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 220, alignment: .leading)
            }

            GridRow(alignment: .firstTextBaseline) {
                Label("Connections per File", systemImage: "point.3.connected.trianglepath.dotted")
                    .font(.subheadline.weight(.semibold))
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Slider(value: $connectionsPerServer, in: 1...16, step: 1)
                            .frame(width: 145)
                        Text("\(Int(connectionsPerServer)) segments")
                            .monospacedDigit()
                            .frame(width: 98, alignment: .leading)
                    }
                }
            }

            GridRow(alignment: .firstTextBaseline) {
                Label("Speed Limit per File", systemImage: "speedometer")
                    .font(.subheadline.weight(.semibold))
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Toggle("Limit each file", isOn: $speedLimitEnabled)
                            .toggleStyle(.switch)
                        Stepper(
                            "\(speedLimitKiBPerSecond) KiB/s",
                            value: $speedLimitKiBPerSecond,
                            in: 1...10_485_760,
                            step: 128
                        )
                        .disabled(!speedLimitEnabled)
                    }
                }
            }

            GridRow(alignment: .top) {
                Label("Authorization", systemImage: "lock.shield")
                    .font(.subheadline.weight(.semibold))
                    .padding(.top, 4)
                VStack(alignment: .leading, spacing: 8) {
                    Toggle("Use authorization", isOn: $useAuthorization)
                        .toggleStyle(.switch)

                    if useAuthorization {
                        HStack(spacing: 8) {
                            TextField("Username", text: $authUsername)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: 145)
                            SecureField("Password", text: $authPassword)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: 145)
                        }
                        Toggle("Save login for this website", isOn: $saveLogin)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private var summarySection: some View {
        CompactSummaryStrip(
            metrics: [
                SummaryMetric(title: "Files", value: "\(pendingDownloads.count)", symbolName: "doc.on.doc"),
                SummaryMetric(title: "Required", value: requiredSpaceText, symbolName: "externaldrive"),
                SummaryMetric(title: "Free", value: freeSpaceText, symbolName: "internaldrive"),
                SummaryMetric(title: "Unknown", value: "\(unknownSizeCount)", symbolName: "questionmark.circle")
            ]
        )
    }

    private var previewSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Preview", systemImage: "list.bullet.rectangle")
                .font(.subheadline.weight(.semibold))

            Table($pendingDownloads) {
                TableColumn("File") { $item in
                    HStack {
                        Image(systemName: item.category.symbolName)
                            .foregroundStyle(categoryColor(item.category))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.fileName)
                                .lineLimit(1)
                        }
                    }
                }

                TableColumn("Size") { $item in
                    Text(ByteFormatter.string(item.sizeBytes))
                        .monospacedDigit()
                }
                .width(86)

                TableColumn("Save To") { $item in
                    Text(item.destinationPath)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                TableColumn("Status") { $item in
                    if item.isMedia {
                        if !item.mediaOptions.isEmpty {
                            Menu {
                                ForEach(item.mediaOptions) { option in
                                    Button {
                                        item.selectedMediaOption = option
                                        if let metadata = item.mediaMetadata {
                                            let cleanTitle = FileClassifier.sanitizedFileName(metadata.title ?? "Media")
                                            item.fileName = "\(cleanTitle).\(option.outputExtension)"
                                            item.category = FileClassifier.category(forFileName: item.fileName)
                                        }
                                    } label: {
                                        Text(option.name)
                                    }
                                }
                            } label: {
                                Text(item.selectedMediaOption?.name ?? "Select Format")
                                    .lineLimit(1)
                            }
                            .menuStyle(.borderlessButton)
                            .buttonStyle(.plain)
                            .fixedSize()
                        } else if case .loading = item.state {
                            HStack {
                                ProgressView().controlSize(.small)
                                Text("Checking")
                            }.foregroundStyle(.secondary)
                        } else {
                            MetadataStatusView(state: item.state)
                        }
                    } else {
                        MetadataStatusView(state: item.state)
                    }
                }
                .width(min: 110, ideal: 140, max: 200)
            }
            .frame(minHeight: 160)
        }
    }

    private var actionBar: some View {
        HStack {
            Text(actionMessage)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)

            if metadataTask != nil {
                Button {
                    metadataTask?.cancel()
                    metadataTask = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }

            Spacer()

            Button("Cancel") {
                dismiss()
            }
            .keyboardShortcut(showingDuplicates ? nil : .cancelAction)

            Button("Add to Queue") {
                addDownloads(start: false)
            }
            .disabled(!canAddDownloads)

            Button("Start Downloads") {
                addDownloads(start: true)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!canAddDownloads)
            .keyboardShortcut(showingDuplicates ? nil : .defaultAction)
        }
    }

    private var advancedTransferSection: some View {
        DisclosureGroup(isExpanded: $showsAdvancedTransfer) {
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
                GridRow(alignment: .firstTextBaseline) {
                    Toggle("Checksum", isOn: $checksumEnabled)
                        .font(.subheadline.weight(.semibold))
                    HStack(spacing: 8) {
                        Picker("Algorithm", selection: $checksumAlgorithm) {
                            ForEach(ChecksumAlgorithm.allCases) { algorithm in
                                Text(algorithm.title).tag(algorithm)
                            }
                        }
                        .labelsHidden()
                        .frame(width: 130)

                        TextField("Expected digest", text: $checksumValue)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.callout, design: .monospaced))
                    }
                    .disabled(!checksumEnabled)
                }

                GridRow(alignment: .top) {
                    Label("Headers", systemImage: "text.quote")
                        .font(.subheadline.weight(.semibold))
                    TextEditor(text: $headerText)
                        .font(.system(.callout, design: .monospaced))
                        .scrollContentBackground(.hidden)
                        .background(.quaternary.opacity(0.35))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .frame(minHeight: 48)
                }

                GridRow(alignment: .firstTextBaseline) {
                    Label("Cookies", systemImage: "circle.hexagongrid.circle")
                        .font(.subheadline.weight(.semibold))
                    TextField("name=value; other=value", text: $cookieText)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.callout, design: .monospaced))
                }

                GridRow(alignment: .top) {
                    Label("Mirrors", systemImage: "point.3.filled.connected.trianglepath.dotted")
                        .font(.subheadline.weight(.semibold))
                    TextEditor(text: $mirrorText)
                        .font(.system(.callout, design: .monospaced))
                        .scrollContentBackground(.hidden)
                        .background(.quaternary.opacity(0.35))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .frame(minHeight: 48)
                }
            }
            .padding(.top, 8)
        } label: {
            Label("Advanced Transfer", systemImage: "slider.horizontal.3")
                .font(.subheadline.weight(.semibold))
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

    private var metadataRequestSignature: String {
        [
            headerText,
            cookieText,
            useAuthorization ? "auth" : "no-auth",
            authUsername,
            authPassword
        ].joined(separator: "\u{1f}")
    }

    private func metadataCredentials(for url: URL) -> DownloadCredentials? {
        if useAuthorization {
            let cleanUsername = authUsername.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !cleanUsername.isEmpty else { return nil }
            return DownloadCredentials(username: cleanUsername, password: authPassword)
        }

        return settings.credentials(for: url)
    }

    private func scheduleMetadataRefresh(for text: String) {
        metadataTask?.cancel()
        metadataTask = Task {
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                refreshMetadata(for: text, isAutoFetch: true)
            }
        }
    }

    private func applyPendingReferer() {
        guard let referer = controller.pendingReferer?.trimmingCharacters(in: .whitespacesAndNewlines),
              !referer.isEmpty,
              URL(string: referer) != nil else {
            controller.pendingReferer = nil
            return
        }

        let refererHeader = "Referer: \(referer)"
        let existingHeaders = DownloadTransferOptionParser.parseHeaders(headerText)
        if !existingHeaders.contains(where: { $0.normalized.name.lowercased() == "referer" }) {
            headerText = headerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? refererHeader
                : "\(headerText.trimmingCharacters(in: .whitespacesAndNewlines))\n\(refererHeader)"
        }
        controller.pendingReferer = nil
    }

    private func refreshMetadata(for text: String, isAutoFetch: Bool) {
        let urls = DownloadURLParser.parse(text)
        metadataTask?.cancel()

        pendingDownloads = urls.map { url in
            let isMedia = MediaDetector.isSupportedMedia(url: url)
            let fileName = FileClassifier.fileName(from: url)
            let category = FileClassifier.category(forFileName: fileName)
            return PendingDownload(
                url: url,
                fileName: fileName,
                category: category,
                defaultDirectory: settings.destinationDirectory(for: category),
                state: .loading,
                isMedia: isMedia
            )
        }

        if let firstURL = urls.first, let creds = settings.credentials(for: firstURL) {
            useAuthorization = true
            authUsername = creds.username
            authPassword = creds.password
            saveLogin = false
        }

        guard !urls.isEmpty else {
            metadataTask = nil
            return
        }

        metadataTask = Task {
            await withTaskGroup(of: PendingDownload.self) { group in
                for item in pendingDownloads {
                    group.addTask {
                        if item.isMedia {
                            var fetchedItem = item
                            do {
                                try await MediaEngineManager.shared.ensureAvailable(addons: [.ytDlp])
                                let (metadata, options) = try await MediaExtractionEngine.fetchMetadata(
                                    for: item.url,
                                    cookieSource: settings.mediaCookieSource,
                                    credentials: metadataCredentials(for: item.url),
                                    transferOptions: transferOptions
                                )
                                fetchedItem.mediaMetadata = metadata
                                fetchedItem.mediaOptions = options
                                if let bestVideo = options.first(where: { !$0.isAudioOnly && $0.name.contains("Best") }) ?? options.first(where: { !$0.isAudioOnly }) ?? options.first {
                                    fetchedItem.selectedMediaOption = bestVideo
                                    let cleanTitle = FileClassifier.sanitizedFileName(metadata.title ?? "Media")
                                    fetchedItem.fileName = "\(cleanTitle).\(bestVideo.outputExtension)"
                                    fetchedItem.category = FileClassifier.category(forFileName: fetchedItem.fileName)
                                }
                                fetchedItem.state = .loaded
                            } catch {
                                fetchedItem.state = .failed(error.localizedDescription)
                            }
                            return fetchedItem
                        } else {
                            return await DownloadMetadataFetcher.fetch(
                                for: item.url,
                                settings: settings,
                                credentials: metadataCredentials(for: item.url),
                                transferOptions: transferOptions,
                                isAutoFetch: isAutoFetch
                            )
                        }
                    }
                }

                for await loadedItem in group {
                    guard !Task.isCancelled else { break }
                    await MainActor.run {
                        if let index = pendingDownloads.firstIndex(where: { $0.url == loadedItem.url }) {
                            pendingDownloads[index] = loadedItem
                        }
                    }
                }
            }
            await MainActor.run {
                metadataTask = nil
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
        var conflicts: [DuplicateDownloadItem] = []
        for pending in pendingDownloads {
            let destURL = overrideDirectory ?? pending.defaultDirectory
            let destPath = destURL.appendingPathComponent(pending.fileName).path
            
            if controller.downloads.contains(where: { $0.url == pending.url && $0.status != .canceled && $0.status != .completed }) {
                conflicts.append(DuplicateDownloadItem(id: pending.id, pendingItem: pending, reason: .existingURL("URL already in queue")))
            } else if controller.downloads.contains(where: { $0.destinationPath == destPath && $0.status != .canceled }) || FileManager.default.fileExists(atPath: destPath) {
                conflicts.append(DuplicateDownloadItem(id: pending.id, pendingItem: pending, reason: .existingFile("File exists at destination")))
            }
        }
        
        if !conflicts.isEmpty {
            conflictingDownloads = conflicts
            pendingStartFlag = start
            showingDuplicates = true
            return
        }
        
        executeAddDownloads(start: start)
    }

    private func executeAddDownloads(start: Bool, conflicts: [DuplicateDownloadItem]? = nil) {
        var finalDownloads = pendingDownloads
        
        if let conflicts {
            for conflict in conflicts {
                guard let index = finalDownloads.firstIndex(where: { $0.id == conflict.id }) else { continue }
                switch conflict.resolution {
                case .skip:
                    finalDownloads.remove(at: index)
                case .rename:
                    let destURL = overrideDirectory ?? finalDownloads[index].defaultDirectory
                    var newName = finalDownloads[index].fileName
                    var count = 1
                    let base = URL(fileURLWithPath: newName).deletingPathExtension().lastPathComponent
                    let ext = URL(fileURLWithPath: newName).pathExtension
                    while controller.downloads.contains(where: { $0.destinationDirectory == destURL && $0.fileName == newName }) || FileManager.default.fileExists(atPath: destURL.appendingPathComponent(newName).path) {
                        newName = "\(base) (\(count))" + (ext.isEmpty ? "" : ".\(ext)")
                        count += 1
                    }
                    finalDownloads[index].fileName = newName
                case .replace:
                    let destURL = overrideDirectory ?? finalDownloads[index].defaultDirectory
                    let path = destURL.appendingPathComponent(finalDownloads[index].fileName).path
                    if let existingIndex = controller.downloads.firstIndex(where: { ($0.destinationPath == path || $0.url == finalDownloads[index].url) && $0.status != .canceled }) {
                        controller.delete(controller.downloads[existingIndex], deleteFiles: true)
                    } else if FileManager.default.fileExists(atPath: path) {
                        try? FileManager.default.removeItem(atPath: path)
                    }
                }
            }
        }

        guard !finalDownloads.isEmpty else {
            dismiss()
            return
        }

        let explicitCredentials = explicitCredentials(for: finalDownloads.map(\.url))

        controller.addPendingDownloads(
            finalDownloads,
            connectionsPerServer: Int(connectionsPerServer),
            overrideDirectory: overrideDirectory,
            startImmediately: start,
            queueID: targetQueueID,
            credentials: explicitCredentials,
            transferOptions: transferOptions,
            speedLimitKiBPerSecond: speedLimitEnabled ? speedLimitKiBPerSecond : nil
        )
        dismiss()
    }

    private func explicitCredentials(for urls: [URL]) -> DownloadCredentials? {
        guard useAuthorization else { return nil }

        let cleanUsername = authUsername.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanUsername.isEmpty else { return nil }

        if saveLogin {
            var savedHosts = Set<String>()
            for url in urls {
                if let host = url.host, !savedHosts.contains(host) {
                    settings.addSiteLogin(urlPattern: host, username: cleanUsername, password: authPassword)
                    savedHosts.insert(host)
                }
            }
        }

        return DownloadCredentials(username: cleanUsername, password: authPassword)
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

private struct SummaryMetric: Identifiable {
    let title: String
    let value: String
    let symbolName: String

    var id: String { title }
}

private struct CompactSummaryStrip: View {
    let metrics: [SummaryMetric]

    var body: some View {
        HStack(spacing: 12) {
            ForEach(metrics) { metric in
                HStack(spacing: 6) {
                    Image(systemName: metric.symbolName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(metric.title)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(metric.value)
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .lineLimit(1)
                }

                if metric.id != metrics.last?.id {
                    Divider()
                        .frame(height: 14)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
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
