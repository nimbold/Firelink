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
            HStack(spacing: 0) {
                // Left Column
                VStack(spacing: 0) {
                    VStack(alignment: .leading, spacing: 16) {
                        linkSection
                        summarySection
                        previewSection
                    }
                    .padding(20)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                Divider()

                // Right Column
                VStack(spacing: 0) {
                    Form {
                        optionsSection
                        advancedTransferSection
                    }
                    .formStyle(.grouped)
                }
                .frame(width: 320)
                .background(Color(NSColor.controlBackgroundColor))
            }
            Divider()
            actionBar
                .padding(16)
                .background(.background)
        }
        .frame(minWidth: 720, idealWidth: 800, minHeight: 620, idealHeight: 680)
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
            linkText = ""
            pendingDownloads = []
            headerText = ""
            cookieText = ""
            mirrorText = ""
            useAuthorization = false
            authUsername = ""
            authPassword = ""
            checksumEnabled = false
            checksumValue = ""
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
                .frame(minHeight: 72, idealHeight: 100, maxHeight: 160)

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
        Group {
            if let firstMedia = pendingDownloads.first(where: { $0.isMedia }) {
                mediaFormatSection(for: firstMedia)
            }

            Section("Save Location") {
                Toggle("Use one folder for all files", isOn: $overrideDestination)
                if overrideDestination {
                    HStack(spacing: 8) {
                        TextField("Automatic by file type", text: $destinationPath)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.callout, design: .monospaced))
                        Button {
                            selectDestination()
                        } label: {
                            Label("Select...", systemImage: "folder.badge.plus")
                        }
                    }
                }
            }

            Section("Queue") {
                Picker("Target Queue", selection: $targetQueueID) {
                    ForEach(controller.queues) { queue in
                        Text(queue.name).tag(queue.id)
                    }
                }
                .labelsHidden()
            }

            Section("Transfer Settings") {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Connections per File")
                    HStack {
                        Slider(value: $connectionsPerServer, in: 1...16, step: 1)
                        Text("\(Int(connectionsPerServer))")
                            .monospacedDigit()
                            .frame(width: 24, alignment: .trailing)
                    }
                }
                
                Toggle("Limit speed per file", isOn: $speedLimitEnabled)
                if speedLimitEnabled {
                    Stepper(
                        "\(speedLimitKiBPerSecond) KiB/s",
                        value: $speedLimitKiBPerSecond,
                        in: 1...10_485_760,
                        step: 128
                    )
                }
            }

            Section("Authorization") {
                Toggle("Use authorization", isOn: $useAuthorization)
                if useAuthorization {
                    TextField("Username", text: $authUsername)
                        .textFieldStyle(.roundedBorder)
                    SecureField("Password", text: $authPassword)
                        .textFieldStyle(.roundedBorder)
                    Toggle("Save login for this website", isOn: $saveLogin)
                        .font(.caption)
                        .foregroundStyle(.secondary)
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
                    if item.isMedia, case .loading = item.state {
                        HStack {
                            ProgressView().controlSize(.small)
                            Text("Checking")
                        }.foregroundStyle(.secondary)
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

    private func updateMediaOption(for firstMedia: PendingDownload, newId: String) {
        for index in pendingDownloads.indices where pendingDownloads[index].isMedia {
            if let option = pendingDownloads[index].mediaOptions.first(where: { $0.id == newId }) {
                pendingDownloads[index].selectedMediaOption = option
                if let metadata = pendingDownloads[index].mediaMetadata {
                    let cleanTitle = FileClassifier.sanitizedFileName(metadata.title ?? "Media")
                    pendingDownloads[index].fileName = "\(cleanTitle).\(option.outputExtension)"
                    pendingDownloads[index].category = FileClassifier.category(forFileName: pendingDownloads[index].fileName)
                }
            }
        }
    }

    @ViewBuilder
    private func mediaFormatSection(for firstMedia: PendingDownload) -> some View {
        Section {
            if firstMedia.mediaOptions.isEmpty {
                HStack(spacing: 8) {
                    if case .loading = firstMedia.state {
                        ProgressView().controlSize(.small)
                        Text("Fetching media options...")
                            .foregroundStyle(.secondary)
                    } else if case .failed(_) = firstMedia.state {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
                        Text("Failed to load options.")
                            .foregroundStyle(.secondary)
                    } else {
                        ProgressView().controlSize(.small)
                        Text("Waiting for metadata...")
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            } else {
                let currentOption = firstMedia.selectedMediaOption ?? firstMedia.mediaOptions.first!
                let availableTypes = Array(Set(firstMedia.mediaOptions.map(\.mediaType))).sorted(by: { $0.rawValue > $1.rawValue })
                let optionsForType = firstMedia.mediaOptions.filter { $0.mediaType == currentOption.mediaType }
                let availableFormats = Array(Set(optionsForType.map(\.containerName))).sorted()
                let optionsForFormat = optionsForType.filter { $0.containerName == currentOption.containerName }
                
                let availableQualities = Array(Set(optionsForFormat.map(\.qualityName))).sorted(by: { 
                     if $0 == "Best" { return true }
                     if $1 == "Best" { return false }
                     return $0 > $1 
                })

                Picker("Type", selection: Binding(
                get: { currentOption.mediaType },
                set: { newType in
                    if let firstOfNewType = firstMedia.mediaOptions.first(where: { $0.mediaType == newType }) {
                        updateMediaOption(for: firstMedia, newId: firstOfNewType.id)
                    }
                }
            )) {
                ForEach(availableTypes, id: \.self) { type in
                    Text(type.rawValue).tag(type)
                }
            }
            .pickerStyle(.segmented)
            .padding(.bottom, 4)

            Picker("Format", selection: Binding(
                get: { currentOption.containerName },
                set: { newFormat in
                    let matching = optionsForType.first(where: { $0.containerName == newFormat && $0.qualityName == currentOption.qualityName })
                    let fallback = optionsForType.first(where: { $0.containerName == newFormat })
                    if let newOption = matching ?? fallback {
                        updateMediaOption(for: firstMedia, newId: newOption.id)
                    }
                }
            )) {
                ForEach(availableFormats, id: \.self) { format in
                    Text(format).tag(format)
                }
            }

            if currentOption.mediaType == .video {
                Picker("Quality", selection: Binding(
                    get: { currentOption.qualityName },
                    set: { newQuality in
                        if let newOption = optionsForFormat.first(where: { $0.qualityName == newQuality }) {
                            updateMediaOption(for: firstMedia, newId: newOption.id)
                        }
                    }
                )) {
                    ForEach(availableQualities, id: \.self) { quality in
                        Text(quality).tag(quality)
                    }
                }
            } else {
                Picker("Quality", selection: .constant("Best")) {
                    Text("Best").tag("Best")
                }
                .disabled(true)
            }
            } // End of else block
        } header: {
            Text("Media Format").foregroundStyle(.blue)
        }
    }

    private var advancedTransferSection: some View {
        Section {
            DisclosureGroup(isExpanded: $showsAdvancedTransfer) {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("Verify Checksum", isOn: $checksumEnabled)
                    if checksumEnabled {
                        Picker("Algorithm", selection: $checksumAlgorithm) {
                            ForEach(ChecksumAlgorithm.allCases) { algorithm in
                                Text(algorithm.title).tag(algorithm)
                            }
                        }
                        TextField("Expected digest", text: $checksumValue)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.callout, design: .monospaced))
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Headers")
                        TextEditor(text: $headerText)
                            .font(.system(.callout, design: .monospaced))
                            .scrollContentBackground(.hidden)
                            .background(.quaternary.opacity(0.35))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .frame(minHeight: 48)
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Cookies")
                        TextField("name=value; other=value", text: $cookieText)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.callout, design: .monospaced))
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Mirrors")
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
                                    transferOptions: transferOptions,
                                    proxyConfiguration: settings.downloadProxyConfiguration
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
