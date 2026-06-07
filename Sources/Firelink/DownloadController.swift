import AppKit
import Combine
import Foundation
import UserNotifications

@MainActor
final class DownloadController: ObservableObject {
    @Published var downloads: [DownloadItem] = []
    @Published var queues: [DownloadQueue] = [.main]
    @Published var engineMessage = ""
    @Published var pendingPasteboardText: String?
    @Published var pendingReferer: String?
    @Published var extensionServerPort: UInt16?
    var pendingAddQueueID: UUID?

    private let settings: AppSettings
    private let engine = Aria2DownloadEngine()
    private let mediaEngine = MediaDownloadEngine()
    private var activeHandles: [UUID: Aria2DownloadEngine.Handle] = [:]
    private var activeMediaHandles: [UUID: MediaDownloadEngine.Handle] = [:]
    private var automaticRetryCounts: [UUID: Int] = [:]
    private var restrictQueueToAutoResume = false
    private var queuePumpScope: QueuePumpScope = .idle
    private var sleepActivity: SleepActivityHandle?
    private var cancellables = Set<AnyCancellable>()
    private let maxAutomaticRetries = 3
    private lazy var storageURL: URL = {
        let supportDir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? URL(fileURLWithPath: NSHomeDirectory())
        return supportDir.appendingPathComponent("Firelink").appendingPathComponent("downloads.json")
    }()
    private var saveTask: Task<Void, Never>?

    init(settings: AppSettings) {
        self.settings = settings

        let shouldResumeRecoveredDownloads = loadDownloads()

        settings.$preventsSleepWhileDownloading
            .sink { [weak self] _ in
                Task { @MainActor in
                    self?.updateSleepActivity()
                }
            }
            .store(in: &cancellables)

        settings.$globalSpeedLimitKiBPerSecond
            .dropFirst()
            .sink { [weak self] _ in
                Task { @MainActor in
                    self?.applySpeedLimitsToActiveDownloads()
                }
            }
            .store(in: &cancellables)

        settings.$maxConcurrentDownloads
            .dropFirst()
            .sink { [weak self] _ in
                Task { @MainActor in
                    self?.applySpeedLimitsToActiveDownloads()
                    self?.pumpQueue()
                }
            }
            .store(in: &cancellables)
            
        $downloads
            .dropFirst()
            .debounce(for: .seconds(2.0), scheduler: RunLoop.main)
            .sink { [weak self] _ in
                self?.saveDownloads()
            }
            .store(in: &cancellables)
            
        NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)
            .sink { [weak self] _ in
                self?.saveDownloads()
            }
            .store(in: &cancellables)

        if shouldResumeRecoveredDownloads {
            Task { @MainActor in
                self.engineMessage = "Recovered downloads from the previous session."
                self.restrictQueueToAutoResume = true
                self.queuePumpScope = .all
                self.pumpQueue()
            }
        }
    }

    deinit {
        sleepActivity?.end()
    }

    var activeCount: Int {
        downloads.filter { $0.status == .downloading }.count
    }

    var queuedCount: Int {
        downloads.filter { $0.status == .queued }.count
    }

    var completedCount: Int {
        downloads.filter { $0.status == .completed }.count
    }

    var unfinishedCount: Int {
        downloads.filter { $0.status != .completed }.count
    }

    var hasAria2: Bool {
        Aria2DownloadEngine.findExecutable() != nil
    }

    private var hasStartableQueuedDownloadIgnoringEngine: Bool {
        downloads.contains { item in
            item.status == .queued &&
                (!restrictQueueToAutoResume || item.autoResumeOnLaunch == true) &&
                isAllowedToStart(item)
        }
    }

    private var hasRunnableQueuedDownload: Bool {
        downloads.contains { item in
            item.status == .queued &&
                (item.mediaFormatSelector != nil || hasAria2) &&
                (!restrictQueueToAutoResume || item.autoResumeOnLaunch == true) &&
                isAllowedToStart(item)
        }
    }

    func add(urlText: String, connectionsPerServer: Int? = nil, queueID: UUID = DownloadQueue.mainQueueID) {
        guard let url = URL(string: urlText.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(),
              ["http", "https", "ftp", "sftp"].contains(scheme) else {
            engineMessage = "Enter a valid HTTP, HTTPS, FTP, or SFTP URL."
            return
        }

        let fileName = FileClassifier.fileName(from: url)
        let category = FileClassifier.category(forFileName: fileName)
        let item = DownloadItem(
            url: url,
            fileName: fileName,
            category: category,
            destinationDirectory: settings.destinationDirectory(for: category),
            connectionsPerServer: min(max(connectionsPerServer ?? settings.perServerConnections, 1), 16),
            credentials: settings.credentials(for: url),
            queueID: normalizedQueueID(queueID)
        )

        if let password = item.credentials?.password, !password.isEmpty {
            KeychainCredentialStore.setPassword(password, for: item.id)
        }

        downloads.append(item)
        engineMessage = "Added \(fileName) to \(category.rawValue)."
        saveDownloads()
    }

    func addPendingDownloads(
        _ pendingDownloads: [PendingDownload],
        connectionsPerServer: Int,
        overrideDirectory: URL?,
        startImmediately: Bool,
        queueID: UUID = DownloadQueue.mainQueueID,
        credentials: DownloadCredentials? = nil,
        transferOptions: DownloadTransferOptions = DownloadTransferOptions(),
        speedLimitKiBPerSecond: Int? = nil
    ) {
        let clampedConnections = min(max(connectionsPerServer, 1), 16)
        let targetQueueID = normalizedQueueID(queueID)
        let speedLimitKiBPerSecond = normalizedSpeedLimit(speedLimitKiBPerSecond)

        let items = pendingDownloads.map { pending in
            let fileName = FileClassifier.sanitizedFileName(pending.fileName)
            return DownloadItem(
                url: pending.url,
                fileName: fileName,
                category: FileClassifier.category(forFileName: fileName),
                destinationDirectory: overrideDirectory ?? pending.defaultDirectory,
                connectionsPerServer: clampedConnections,
                credentials: credentials ?? settings.credentials(for: pending.url),
                checksum: transferOptions.checksum,
                requestHeaders: transferOptions.requestHeaders,
                cookieHeader: transferOptions.cookieHeader,
                mirrorURLs: transferOptions.mirrorURLs,
                speedLimitKiBPerSecond: speedLimitKiBPerSecond,
                sizeBytes: pending.sizeBytes,
                bytesText: ByteFormatter.string(pending.sizeBytes),
                message: startImmediately ? "Queued to start" : "Added to queue",
                queueID: targetQueueID
            )
        }

        for item in items {
            if let password = item.credentials?.password, !password.isEmpty {
                KeychainCredentialStore.setPassword(password, for: item.id)
            }
        }

        downloads.append(contentsOf: items)
        engineMessage = "Added \(items.count) download\(items.count == 1 ? "" : "s")."
        saveDownloads()

        if startImmediately {
            startQueue(queueID: targetQueueID)
        }
    }

    func addMediaDownload(_ item: DownloadItem, startImmediately: Bool) {
        var item = item
        item.fileName = FileClassifier.sanitizedFileName(item.fileName)
        item.category = FileClassifier.category(forFileName: item.fileName)
        item.connectionsPerServer = 1
        item.speedLimitKiBPerSecond = normalizedSpeedLimit(item.speedLimitKiBPerSecond)
        item.queueID = normalizedQueueID(item.queueID ?? DownloadQueue.mainQueueID)

        if let password = item.credentials?.password, !password.isEmpty {
            KeychainCredentialStore.setPassword(password, for: item.id)
        }

        downloads.append(item)
        engineMessage = "Added \(item.fileName) to \(item.category.rawValue)."
        saveDownloads()

        if startImmediately {
            startQueue(queueID: item.queueID ?? DownloadQueue.mainQueueID)
        }
    }

    func startQueue(queueID: UUID? = nil) {
        engineMessage = ""
        restrictQueueToAutoResume = false
        if let queueID {
            let queueID = normalizedQueueID(queueID)
            switch queuePumpScope {
            case .all:
                break
            case .idle:
                queuePumpScope = .scoped(queueIDs: [queueID], itemIDs: [])
            case .scoped(var queueIDs, let itemIDs):
                queueIDs.insert(queueID)
                queuePumpScope = .scoped(queueIDs: queueIDs, itemIDs: itemIDs)
            }
        } else {
            queuePumpScope = .all
        }
        markQueuedDownloadsForAutoResume(queueID: queueID)
        pumpQueue()
    }

    func pause(_ item: DownloadItem) {
        activeHandles[item.id]?.cancel()
        activeHandles[item.id] = nil
        activeMediaHandles[item.id]?.cancel()
        activeMediaHandles[item.id] = nil
        update(item.id) {
            $0.status = .paused
            $0.message = "Paused. Resume will continue from the partial file."
            $0.autoResumeOnLaunch = false
        }
        automaticRetryCounts[item.id] = nil
        saveDownloads()
        applySpeedLimitsToActiveDownloads()
        updateSleepActivity()
        pumpQueue()
    }

    func pauseActiveDownloads(queueID: UUID? = nil) {
        let targetQueueID = queueID.map(normalizedQueueID)
        let activeItems = downloads.filter { item in
            item.status == .downloading && (targetQueueID == nil || item.queueID == targetQueueID)
        }

        guard !activeItems.isEmpty else { return }

        for item in activeItems {
            activeHandles[item.id]?.cancel()
            activeHandles[item.id] = nil
            activeMediaHandles[item.id]?.cancel()
            activeMediaHandles[item.id] = nil
            update(item.id) {
                $0.status = .paused
                $0.message = "Paused. Resume will continue from the partial file."
                $0.autoResumeOnLaunch = false
            }
            automaticRetryCounts[item.id] = nil
        }

        engineMessage = "Paused \(activeItems.count) active download\(activeItems.count == 1 ? "" : "s")."
        saveDownloads()
        applySpeedLimitsToActiveDownloads()
        updateSleepActivity()
        pumpQueue()
    }

    func queue(_ item: DownloadItem) {
        activeHandles[item.id]?.cancel()
        activeHandles[item.id] = nil
        activeMediaHandles[item.id]?.cancel()
        activeMediaHandles[item.id] = nil
        update(item.id) {
            $0.status = .queued
            if item.status != .paused {
                $0.progress = 0
                $0.speedText = "-"
                $0.etaText = "-"
                $0.connectionCount = 0
            }
            $0.message = "Added to queue"
            $0.autoResumeOnLaunch = false
        }
        automaticRetryCounts[item.id] = nil
        saveDownloads()
        applySpeedLimitsToActiveDownloads()
        updateSleepActivity()
    }

    func assignToQueue(itemIDs: Set<UUID>, queueID: UUID) {
        let queueID = normalizedQueueID(queueID)
        var changed = false

        for index in downloads.indices where itemIDs.contains(downloads[index].id) {
            guard downloads[index].status != .completed,
                  downloads[index].status != .downloading else {
                continue
            }

            downloads[index].status = .queued
            downloads[index].queueID = queueID
            downloads[index].message = "Added to \(queueName(for: queueID))"
            downloads[index].autoResumeOnLaunch = false
            automaticRetryCounts[downloads[index].id] = nil
            changed = true
        }

        if changed {
            saveDownloads()
            updateSleepActivity()
        }
    }

    func resume(_ item: DownloadItem) {
        restrictQueueToAutoResume = false
        update(item.id) {
            $0.status = .queued
            $0.message = ""
            $0.autoResumeOnLaunch = true
        }
        queuePumpScope = queuePumpScope.includingItem(item.id)
        automaticRetryCounts[item.id] = nil
        saveDownloads()
        pumpQueue()
    }

    func redownload(_ item: DownloadItem) {
        trashFiles(for: item)
        restrictQueueToAutoResume = false
        update(item.id) {
            $0.status = .queued
            $0.progress = 0
            $0.speedText = "-"
            $0.etaText = "-"
            $0.connectionCount = 0
            $0.message = "Redownloading"
            $0.autoResumeOnLaunch = true
        }
        queuePumpScope = queuePumpScope.includingItem(item.id)
        automaticRetryCounts[item.id] = nil
        saveDownloads()
        pumpQueue()
    }

    func cancel(_ item: DownloadItem) {
        activeHandles[item.id]?.cancel()
        activeHandles[item.id] = nil
        activeMediaHandles[item.id]?.cancel()
        activeMediaHandles[item.id] = nil
        update(item.id) {
            $0.status = .canceled
            $0.message = "Canceled"
            $0.autoResumeOnLaunch = false
        }
        automaticRetryCounts[item.id] = nil
        saveDownloads()
        applySpeedLimitsToActiveDownloads()
        updateSleepActivity()
        pumpQueue()
    }

    func remove(at offsets: IndexSet, deleteFiles: Bool = false) {
        for index in offsets {
            let item = downloads[index]
            delete(item, deleteFiles: deleteFiles)
        }
    }

    func delete(_ item: DownloadItem, deleteFiles: Bool = false) {
        activeHandles[item.id]?.cancel()
        activeHandles[item.id] = nil
        activeMediaHandles[item.id]?.cancel()
        activeMediaHandles[item.id] = nil
        if deleteFiles {
            trashFiles(for: item)
        } else if item.status != .completed {
            removeCacheFiles(for: item)
        }
        KeychainCredentialStore.deletePassword(for: item.id)
        downloads.removeAll { $0.id == item.id }
        automaticRetryCounts[item.id] = nil
        saveDownloads()
        applySpeedLimitsToActiveDownloads()
        updateSleepActivity()
    }

    func move(from source: IndexSet, to destination: Int) {
        downloads.move(fromOffsets: source, toOffset: destination)
        saveDownloads()
    }

    func queueName(for id: UUID) -> String {
        queues.first(where: { $0.id == normalizedQueueID(id) })?.name ?? DownloadQueue.main.name
    }

    func queueItems(for id: UUID) -> [DownloadItem] {
        let id = normalizedQueueID(id)
        return downloads.filter { validQueueID($0.queueID) == id }
    }

    func queueCount(for id: UUID) -> Int {
        queueItems(for: id).count
    }

    @discardableResult
    func addQueue() -> DownloadQueue {
        var index = 2
        var name = "Queue \(index)"
        let existingNames = Set(queues.map(\.name))
        while existingNames.contains(name) {
            index += 1
            name = "Queue \(index)"
        }

        let queue = DownloadQueue(name: name)
        queues.append(queue)
        saveDownloads()
        return queue
    }

    func renameQueue(id: UUID, name: String) {
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty,
              id != DownloadQueue.mainQueueID,
              let index = queues.firstIndex(where: { $0.id == id }) else {
            return
        }

        queues[index].name = cleanName
        saveDownloads()
    }

    func removeQueue(id: UUID) {
        guard id != DownloadQueue.mainQueueID,
              queues.contains(where: { $0.id == id }) else {
            return
        }

        for index in downloads.indices where validQueueID(downloads[index].queueID) == id {
            downloads[index].queueID = nil
        }
        queues.removeAll { $0.id == id }
        engineMessage = "Removed queue. Downloads remain in Unfinished."
        saveDownloads()
    }

    func moveDownload(_ itemID: UUID, before targetID: UUID, in queueID: UUID) {
        let queueID = normalizedQueueID(queueID)
        guard itemID != targetID,
              let source = downloads.firstIndex(where: { $0.id == itemID && validQueueID($0.queueID) == queueID }),
              let target = downloads.firstIndex(where: { $0.id == targetID && validQueueID($0.queueID) == queueID }) else {
            return
        }

        let item = downloads.remove(at: source)
        let insertionIndex = source < target ? target - 1 : target
        downloads.insert(item, at: insertionIndex)
        saveDownloads()
    }

    private func pumpQueue() {
        guard hasStartableQueuedDownloadIgnoringEngine else {
            return
        }

        guard hasRunnableQueuedDownload else {
            engineMessage = "aria2c is not installed. Run `brew install aria2` to enable downloads."
            return
        }

        pruneActiveQueueScopes()

        while activeCount < settings.maxConcurrentDownloads,
              let next = downloads.first(where: { item in
                  item.status == .queued &&
                      (item.mediaFormatSelector != nil || hasAria2) &&
                      (!restrictQueueToAutoResume || item.autoResumeOnLaunch == true) &&
                      isAllowedToStart(item)
              }) {
            start(next)
        }

        if restrictQueueToAutoResume &&
            activeCount == 0 &&
            !downloads.contains(where: { $0.status == .queued && $0.autoResumeOnLaunch == true }) {
            restrictQueueToAutoResume = false
        }

        pruneActiveQueueScopes()
    }

    private func start(_ item: DownloadItem) {
        update(item.id) {
            $0.status = .downloading
            $0.lastTryAt = Date()
            $0.message = "Starting"
            $0.speedText = "-"
            $0.etaText = "-"
            $0.autoResumeOnLaunch = true
        }
        saveDownloads()

        if item.mediaFormatSelector != nil {
            Task {
                do {
                    let handle = try await mediaEngine.start(
                        item: item,
                        cookieSource: settings.mediaCookieSource,
                        proxyConfiguration: settings.downloadProxyConfiguration,
                        speedLimitKiBPerSecond: effectiveSpeedLimitKiBPerSecond(for: item),
                        progress: { [weak self] progress in
                            Task { @MainActor in
                                self?.update(item.id) {
                                    guard $0.status == .downloading else { return }
                                    $0.progress = progress.fraction
                                    $0.bytesText = progress.bytesText
                                    $0.speedText = progress.speedText
                                    $0.etaText = progress.etaText
                                    $0.connectionCount = progress.connectionCount
                                    if $0.message == "Starting" {
                                        $0.message = "Downloading Media"
                                    }
                                }
                            }
                        },
                        messageUpdate: { [weak self] message in
                            Task { @MainActor in
                                self?.update(item.id) {
                                    guard $0.status == .downloading else { return }
                                    $0.message = message
                                }
                            }
                        },
                        completion: { [weak self] result in
                            Task { @MainActor in
                                self?.handleCompletion(item: item, result: result, isMedia: true)
                            }
                        }
                    )
                    activeMediaHandles[item.id] = handle
                } catch {
                    handleDownloadFailure(itemID: item.id, error: error)
                    applySpeedLimitsToActiveDownloads()
                    updateSleepActivity()
                    pumpQueue()
                }
            }
        } else {
            do {
                let handle = try engine.start(
                    item: item,
                    proxyConfiguration: settings.downloadProxyConfiguration,
                    speedLimitKiBPerSecond: effectiveSpeedLimitKiBPerSecond(for: item),
                    progress: { [weak self] progress in
                        Task { @MainActor in
                            self?.update(item.id) {
                                guard $0.status == .downloading else { return }
                                $0.progress = progress.fraction
                                $0.bytesText = progress.bytesText
                                $0.speedText = progress.speedText
                                $0.etaText = progress.etaText
                                $0.connectionCount = progress.connectionCount
                                $0.message = "Downloading"
                            }
                        }
                    },
                    completion: { [weak self] result in
                        Task { @MainActor in
                            self?.handleCompletion(item: item, result: result, isMedia: false)
                        }
                    }
                )
                activeHandles[item.id] = handle
                update(item.id) {
                    $0.rpcPort = handle.rpcPort
                    $0.rpcSecret = handle.rpcSecret
                    $0.message = "Process \(handle.processIdentifier)"
                }
                saveDownloads()
                applySpeedLimitsToActiveDownloads()
                updateSleepActivity()
            } catch {
                handleDownloadFailure(itemID: item.id, error: error)
                applySpeedLimitsToActiveDownloads()
                updateSleepActivity()
                pumpQueue()
            }
        }
    }

    private func handleCompletion(item: DownloadItem, result: Result<Void, Error>, isMedia: Bool) {
        if isMedia {
            activeMediaHandles[item.id] = nil
        } else {
            activeHandles[item.id] = nil
        }

        switch result {
        case .success:
            self.automaticRetryCounts[item.id] = nil
            self.update(item.id) {
                $0.status = .completed
                $0.progress = 1
                $0.speedText = "-"
                $0.etaText = "-"
                $0.message = "Saved to \($0.destinationPath)"
                $0.autoResumeOnLaunch = false
            }
            self.saveDownloads()
            self.showNotification(title: "Download Completed", body: item.fileName)
        case .failure(let error):
            if self.downloads.first(where: { $0.id == item.id })?.status == .paused ||
                self.downloads.first(where: { $0.id == item.id })?.status == .canceled {
                return
            }
            self.handleDownloadFailure(itemID: item.id, error: error)
        }

        self.pumpQueue()
        self.applySpeedLimitsToActiveDownloads()
        self.updateSleepActivity()
    }

    private func update(_ id: UUID, mutate: (inout DownloadItem) -> Void) {
        guard let index = downloads.firstIndex(where: { $0.id == id }) else { return }
        mutate(&downloads[index])
    }

    func updateDownload(
        id: UUID,
        url: URL,
        fileName: String,
        destinationDirectory: URL,
        connectionsPerServer: Int,
        credentials: DownloadCredentials?,
        transferOptions: DownloadTransferOptions,
        speedLimitKiBPerSecond: Int?
    ) {
        update(id) {
            $0.url = url
            $0.fileName = FileClassifier.sanitizedFileName(fileName)
            $0.category = FileClassifier.category(forFileName: $0.fileName)
            $0.destinationDirectory = destinationDirectory
            $0.connectionsPerServer = min(max(connectionsPerServer, 1), 16)
            $0.credentials = credentials
            $0.checksum = transferOptions.checksum
            $0.requestHeaders = transferOptions.requestHeaders
            $0.cookieHeader = transferOptions.cookieHeader
            $0.mirrorURLs = transferOptions.mirrorURLs
            $0.speedLimitKiBPerSecond = normalizedSpeedLimit(speedLimitKiBPerSecond)
            $0.message = "Properties updated"
        }
        if let password = credentials?.password, !password.isEmpty {
            KeychainCredentialStore.setPassword(password, for: id)
        } else if credentials == nil {
            KeychainCredentialStore.deletePassword(for: id)
        }
        applySpeedLimitToActiveDownload(id: id)
        saveDownloads()
    }

    private func normalizedSpeedLimit(_ value: Int?) -> Int? {
        SpeedLimitPolicy.normalized(value)
    }

    private func effectiveSpeedLimitKiBPerSecond(for item: DownloadItem) -> Int? {
        SpeedLimitPolicy.effectiveLimit(
            itemLimit: item.speedLimitKiBPerSecond,
            globalLimit: settings.globalSpeedLimitKiBPerSecond,
            activeDownloadCount: activeCount
        )
    }

    private func applySpeedLimitsToActiveDownloads() {
        for item in downloads where item.status == .downloading {
            applySpeedLimitToActiveDownload(id: item.id)
        }
    }

    private func applySpeedLimitToActiveDownload(id: UUID) {
        guard let handle = activeHandles[id],
              let item = downloads.first(where: { $0.id == id }) else {
            return
        }

        let limit = effectiveSpeedLimitKiBPerSecond(for: item)
        Task {
            await Aria2DownloadEngine.updateSpeedLimit(handle: handle, speedLimitKiBPerSecond: limit)
        }
    }

    private func markQueuedDownloadsForAutoResume(queueID: UUID?) {
        if let queueID {
            let normalizedID = normalizedQueueID(queueID)
            for index in downloads.indices where downloads[index].status == .queued &&
                validQueueID(downloads[index].queueID) == normalizedID {
                downloads[index].autoResumeOnLaunch = true
            }
        } else {
            for index in downloads.indices where downloads[index].status == .queued {
                downloads[index].autoResumeOnLaunch = true
            }
        }
        saveDownloads()
    }

    private func handleDownloadFailure(itemID: UUID, error: Error) {
        let retryCount = automaticRetryCounts[itemID] ?? 0

        guard isAutomaticallyRecoverable(error), retryCount < maxAutomaticRetries else {
            automaticRetryCounts[itemID] = nil
            update(itemID) {
                $0.status = .failed
                $0.speedText = "-"
                $0.etaText = "-"
                $0.connectionCount = 0
                $0.message = error.localizedDescription
                $0.autoResumeOnLaunch = false
            }
            saveDownloads()
            if let item = downloads.first(where: { $0.id == itemID }) {
                showNotification(title: "Download Failed", body: item.fileName)
            }
            return
        }

        automaticRetryCounts[itemID] = retryCount + 1
        update(itemID) {
            $0.status = .queued
            $0.speedText = "-"
            $0.etaText = "-"
            $0.connectionCount = 0
            $0.message = "Connection interrupted. Retrying from partial file (\(retryCount + 1)/\(maxAutomaticRetries))."
            $0.autoResumeOnLaunch = true
        }
        saveDownloads()
    }

    private func isAutomaticallyRecoverable(_ error: Error) -> Bool {
        guard let engineError = error as? Aria2DownloadEngine.EngineError else {
            return true
        }

        switch engineError {
        case .executableNotFound, .unsupportedProxy:
            return false
        case .launchFailed:
            return true
        }
    }

    private func isAllowedToStart(_ item: DownloadItem) -> Bool {
        switch queuePumpScope {
        case .idle:
            return false
        case .all:
            return true
        case .scoped(let queueIDs, let itemIDs):
            if itemIDs.contains(item.id) {
                return true
            }
            guard let queueID = validQueueID(item.queueID) else { return false }
            return queueIDs.contains(queueID)
        }
    }

    private func pruneActiveQueueScopes() {
        switch queuePumpScope {
        case .idle:
            return
        case .all:
            if !downloads.contains(where: { $0.status == .queued || $0.status == .downloading }) {
                queuePumpScope = .idle
            }
        case .scoped(let queueIDs, let itemIDs):
            let activeQueueIDs = queueIDs.filter { queueID in
                downloads.contains { item in
                    validQueueID(item.queueID) == queueID &&
                        (item.status == .queued || item.status == .downloading)
                }
            }
            let activeItemIDs = itemIDs.filter { itemID in
                downloads.contains { item in
                    item.id == itemID && (item.status == .queued || item.status == .downloading)
                }
            }
            queuePumpScope = activeQueueIDs.isEmpty && activeItemIDs.isEmpty
                ? .idle
                : .scoped(queueIDs: activeQueueIDs, itemIDs: activeItemIDs)
        }
    }

    private enum QueuePumpScope {
        case idle
        case all
        case scoped(queueIDs: Set<UUID>, itemIDs: Set<UUID>)

        func includingItem(_ itemID: UUID) -> QueuePumpScope {
            switch self {
            case .idle:
                return .scoped(queueIDs: [], itemIDs: [itemID])
            case .all:
                return .all
            case .scoped(let queueIDs, var itemIDs):
                itemIDs.insert(itemID)
                return .scoped(queueIDs: queueIDs, itemIDs: itemIDs)
            }
        }
    }

    private func updateSleepActivity() {
        let shouldPreventSleep = settings.preventsSleepWhileDownloading && activeCount > 0

        if shouldPreventSleep, sleepActivity == nil {
            sleepActivity = SleepActivityHandle(activity: ProcessInfo.processInfo.beginActivity(
                options: [.idleSystemSleepDisabled],
                reason: "Firelink is downloading files."
            ))
        } else if !shouldPreventSleep, let activity = sleepActivity {
            activity.end()
            sleepActivity = nil
        }
    }

    private func removeCacheFiles(for item: DownloadItem) {
        let fileURL = item.destinationDirectory.appendingPathComponent(item.fileName)
        let candidates = [URL(fileURLWithPath: fileURL.path + ".aria2")]

        for candidate in candidates where FileManager.default.fileExists(atPath: candidate.path) {
            try? FileManager.default.removeItem(at: candidate)
        }
    }

    private func trashFiles(for item: DownloadItem) {
        let fileURL = item.destinationDirectory.appendingPathComponent(item.fileName)
        let candidates = [
            fileURL,
            URL(fileURLWithPath: fileURL.path + ".aria2")
        ]

        for candidate in candidates where FileManager.default.fileExists(atPath: candidate.path) {
            try? FileManager.default.trashItem(at: candidate, resultingItemURL: nil)
        }
    }

    private func saveDownloads() {
        let queuesCopy = queues
        let downloadsCopy = downloads.map(\.redactedForPersistence)
        let storageURL = self.storageURL

        saveTask?.cancel()
        saveTask = Task.detached(priority: .background) {
            do {
                let directory = storageURL.deletingLastPathComponent()
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: nil)
                let state = StoredDownloadState(queues: queuesCopy, downloads: downloadsCopy)
                let data = try JSONEncoder().encode(state)
                
                guard !Task.isCancelled else { return }
                try data.write(to: storageURL, options: .atomic)
            } catch {
                print("Failed to save downloads: \(error)")
            }
        }
    }

    private func loadDownloads() -> Bool {
        do {
            guard FileManager.default.fileExists(atPath: storageURL.path) else { return false }
            let data = try Data(contentsOf: storageURL)
            let state: StoredDownloadState
            let isLegacyDownloadList: Bool
            if let storedState = try? JSONDecoder().decode(StoredDownloadState.self, from: data) {
                state = storedState
                isLegacyDownloadList = false
            } else {
                state = StoredDownloadState(
                    queues: [.main],
                    downloads: try JSONDecoder().decode([DownloadItem].self, from: data)
                )
                isLegacyDownloadList = true
            }

            var shouldResumeRecoveredDownloads = false
            var shouldRewriteStoredDownloads = isLegacyDownloadList
            self.queues = normalizedQueues(state.queues)
            self.downloads = state.downloads.map { item in
                var adjusted = item
                let redacted = adjusted.redactedForPersistence
                if redacted != adjusted {
                    adjusted = redacted
                    shouldRewriteStoredDownloads = true
                }
                adjusted.queueID = validQueueID(adjusted.queueID)
                if isLegacyDownloadList, item.queueID == nil {
                    adjusted.queueID = DownloadQueue.mainQueueID
                }
                
                if adjusted.credentials != nil, let storedPassword = KeychainCredentialStore.password(for: adjusted.id) {
                    adjusted.credentials?.password = storedPassword
                }

                if adjusted.status == .completed && adjusted.progress != 1 {
                    adjusted.progress = 1
                    shouldRewriteStoredDownloads = true
                }

                if adjusted.status == .completed &&
                    (adjusted.speedText != "-" || adjusted.etaText != "-" || adjusted.connectionCount != 0 || adjusted.autoResumeOnLaunch != false) {
                    adjusted.speedText = "-"
                    adjusted.etaText = "-"
                    adjusted.connectionCount = 0
                    adjusted.autoResumeOnLaunch = false
                    shouldRewriteStoredDownloads = true
                }

                if adjusted.status == .downloading {
                    adjusted.status = .queued
                    adjusted.message = "Recovered after restart. Resuming from partial file."
                    adjusted.speedText = "-"
                    adjusted.etaText = "-"
                    adjusted.connectionCount = 0
                    adjusted.autoResumeOnLaunch = true
                    shouldResumeRecoveredDownloads = true
                } else if adjusted.status == .queued && adjusted.autoResumeOnLaunch == true {
                    adjusted.message = "Recovered queued download."
                    shouldResumeRecoveredDownloads = true
                }
                return adjusted
            }

            if shouldResumeRecoveredDownloads || shouldRewriteStoredDownloads {
                saveDownloads()
            }
            return shouldResumeRecoveredDownloads
        } catch {
            print("Failed to load downloads: \(error)")
            return false
        }
    }

    private func normalizedQueueID(_ id: UUID?) -> UUID {
        validQueueID(id) ?? DownloadQueue.mainQueueID
    }

    private func validQueueID(_ id: UUID?) -> UUID? {
        guard let id, queues.contains(where: { $0.id == id }) else {
            return nil
        }
        return id
    }

    private func normalizedQueues(_ queues: [DownloadQueue]) -> [DownloadQueue] {
        var normalized = queues
        if !normalized.contains(where: { $0.id == DownloadQueue.mainQueueID }) {
            normalized.insert(.main, at: 0)
        }

        if let mainIndex = normalized.firstIndex(where: { $0.id == DownloadQueue.mainQueueID }), mainIndex != 0 {
            let main = normalized.remove(at: mainIndex)
            normalized.insert(main, at: 0)
        }
        return normalized
    }

    private func showNotification(title: String, body: String) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            UNUserNotificationCenter.current().add(request)
        }
    }
}

private struct StoredDownloadState: Codable {
    var queues: [DownloadQueue]
    var downloads: [DownloadItem]
}

enum SpeedLimitPolicy {
    static let maximumKiBPerSecond = 10_485_760

    static func normalized(_ value: Int?) -> Int? {
        guard let value, value > 0 else { return nil }
        return min(value, maximumKiBPerSecond)
    }

    static func effectiveLimit(
        itemLimit: Int?,
        globalLimit: Int?,
        activeDownloadCount: Int
    ) -> Int? {
        let itemLimit = normalized(itemLimit)
        let globalLimit = normalized(globalLimit)
            .map { max(1, $0 / max(activeDownloadCount, 1)) }

        switch (itemLimit, globalLimit) {
        case let (.some(itemLimit), .some(globalLimit)):
            return min(itemLimit, globalLimit)
        case let (.some(itemLimit), .none):
            return itemLimit
        case let (.none, .some(globalLimit)):
            return globalLimit
        case (.none, .none):
            return nil
        }
    }
}

private final class SleepActivityHandle: @unchecked Sendable {
    private let activity: NSObjectProtocol

    init(activity: NSObjectProtocol) {
        self.activity = activity
    }

    func end() {
        ProcessInfo.processInfo.endActivity(activity)
    }
}
