import Foundation

struct RawMediaFormat: Decodable, Sendable, Equatable {
    let format_id: String?
    let ext: String?
    let resolution: String?
    let format_note: String?
    let vcodec: String?
    let acodec: String?
    let height: Int?
    let filesize: Int64?
    let filesize_approx: Int64?
}

struct MediaMetadata: Decodable, Sendable, Equatable {
    let id: String?
    let title: String?
    let uploader: String?
    let channel: String?
    let thumbnail: URL?
    let duration: Double?
    let formats: [RawMediaFormat]?

    var displayUploader: String? {
        channel ?? uploader
    }
}

enum MediaType: String, Sendable, Equatable {
    case video = "Video"
    case audio = "Audio"
}

struct CleanFormatOption: Identifiable, Equatable, Sendable {
    var id: String { name }
    let name: String
    let formatSelector: String
    let isAudioOnly: Bool
    let symbol: String
    let outputExtension: String
    let detail: String
    let estimatedBytes: Int64?
    
    let mediaType: MediaType
    let qualityName: String
    let containerName: String
}

enum MediaExtractionEngine {
    private final class CacheEntry {
        let metadata: MediaMetadata
        let options: [CleanFormatOption]
        let date: Date
        init(metadata: MediaMetadata, options: [CleanFormatOption], date: Date) {
            self.metadata = metadata
            self.options = options
            self.date = date
        }
    }
    nonisolated(unsafe) private static let metadataCache = NSCache<NSURL, CacheEntry>()

    private static let metadataTimeoutSeconds: UInt64 = 120

    enum ExtractionError: Error, LocalizedError {
        case processFailed(String)
        case invalidOutput
        case parsingFailed(Error)
        case timedOut

        var errorDescription: String? {
            switch self {
            case .processFailed(let msg): return "Extraction failed: \(msg)"
            case .invalidOutput: return "Invalid output from media engine."
            case .parsingFailed(let err): return "Failed to parse metadata: \(err.localizedDescription)"
            case .timedOut: return "Fetching metadata timed out. Try again or change the selected browser cookie source."
            }
        }
    }

    static func fetchMetadata(
        for url: URL,
        cookieSource: BrowserCookieSource,
        credentials: DownloadCredentials?,
        transferOptions: DownloadTransferOptions,
        proxyConfiguration: DownloadProxyConfiguration
    ) async throws -> (MediaMetadata, [CleanFormatOption]) {
        if let cached = metadataCache.object(forKey: url as NSURL), Date().timeIntervalSince(cached.date) < 300 {
            return (cached.metadata, cached.options)
        }
        guard let ytDlpURL = await MediaEngineManager.shared.preparedBinaryPath(for: .ytDlp),
              FileManager.default.isExecutableFile(atPath: ytDlpURL.path) else {
            throw ExtractionError.processFailed("yt-dlp binary not found.")
        }
        let ytDlpPath = ytDlpURL.path

        var args = [
            "-J",
            "--no-warnings",
            "--no-playlist",
            "--no-check-formats",
            "--socket-timeout", "20",
            "--retries", "3",
            "--extractor-retries", "3",
            "--compat-options", "no-youtube-unavailable-videos"
        ]

        if let ffmpegURL = await MediaEngineManager.shared.binaryPath(for: .ffmpeg),
           FileManager.default.isExecutableFile(atPath: ffmpegURL.path) {
            args.append(contentsOf: ["--ffmpeg-location", ffmpegURL.path])
        }

        if let proxyURI = proxyConfiguration.customProxyURI, proxyConfiguration.mode == .custom {
            args.append(contentsOf: ["--proxy", proxyURI])
        }

        let tempConfigDir = appendCommonArguments(
            to: &args,
            cookieSource: cookieSource,
            credentials: credentials,
            transferOptions: transferOptions,
            preferredDenoURL: cachedDenoURL(near: ytDlpURL)
        )
        defer {
            if let tempConfigDir {
                try? FileManager.default.removeItem(at: tempConfigDir)
            }
        }
        args.append(url.absoluteString)

        let data = try await YTDLPMetadataProcess(
            executableURL: URL(fileURLWithPath: ytDlpPath),
            arguments: args
        ).run(timeoutSeconds: metadataTimeoutSeconds)

        guard !data.isEmpty else {
            throw ExtractionError.invalidOutput
        }

        do {
            let metadata = try JSONDecoder().decode(MediaMetadata.self, from: data)
            let options = extractOptions(from: metadata)
            metadataCache.setObject(CacheEntry(metadata: metadata, options: options, date: Date()), forKey: url as NSURL)
            return (metadata, options)
        } catch {
            throw ExtractionError.parsingFailed(error)
        }
    }

    static func appendCommonArguments(
        to args: inout [String],
        cookieSource: BrowserCookieSource,
        credentials: DownloadCredentials?,
        transferOptions: DownloadTransferOptions,
        preferredDenoURL: URL? = nil
    ) -> URL? {
        if let browserName = cookieSource.ytDlpBrowserName {
            args.append(contentsOf: ["--cookies-from-browser", browserName])
        }

        appendJavaScriptRuntimeArguments(to: &args, preferredDenoURL: preferredDenoURL)

        for header in transferOptions.requestHeaders.map(\.normalized) where !header.isEmpty {
            args.append(contentsOf: ["--add-header", header.headerLine])
        }

        if let cookieHeader = transferOptions.cookieHeader?.trimmingCharacters(in: .whitespacesAndNewlines),
           !cookieHeader.isEmpty {
            args.append(contentsOf: ["--add-header", "Cookie: \(cookieHeader)"])
        }

        var tempConfigDir: URL?
        if let credentials, !credentials.isEmpty {
            let configContent = "--username \"\(credentials.username)\"\n--password \"\(credentials.password)\"\n"
            let tempDir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("firelink-yt-dlp-\(UUID().uuidString)")
            try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let fileURL = tempDir.appendingPathComponent("yt-dlp.conf")
            try? configContent.write(to: fileURL, atomically: true, encoding: .utf8)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
            args.append(contentsOf: ["--config-locations", fileURL.path])
            tempConfigDir = tempDir
        }
        return tempConfigDir
    }

    private static func appendJavaScriptRuntimeArguments(
        to args: inout [String],
        preferredDenoURL: URL?
    ) {
        var runtimes: [String] = []
        if let denoPath = executablePath(at: preferredDenoURL) ??
            bundledExecutablePath(named: "deno") ??
            executablePath(named: "deno", candidates: [
            "/opt/homebrew/bin/deno",
            "/usr/local/bin/deno"
        ]) {
            runtimes.append("deno:\(denoPath)")
        }

        if let nodePath = executablePath(named: "node", candidates: [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node"
        ]) {
            runtimes.append("node:\(nodePath)")
        }

        if !runtimes.isEmpty {
            args.append(contentsOf: ["--js-runtimes", runtimes.joined(separator: ",")])
        }
    }

    private static func cachedDenoURL(near ytDlpURL: URL) -> URL? {
        let denoURL = ytDlpURL.deletingLastPathComponent().appendingPathComponent("deno")
        return FileManager.default.isExecutableFile(atPath: denoURL.path) ? denoURL : nil
    }

    private static func executablePath(at url: URL?) -> String? {
        guard let url, FileManager.default.isExecutableFile(atPath: url.path) else {
            return nil
        }
        return url.path
    }

    private static func bundledExecutablePath(named name: String) -> String? {
        if let bundled = Bundle.main.url(forResource: name, withExtension: nil),
           FileManager.default.isExecutableFile(atPath: bundled.path) {
            return bundled.path
        }

        if Bundle.main.bundleURL.pathExtension.lowercased() != "app" {
            #if SWIFT_PACKAGE
            if let bundled = Bundle.module.url(forResource: name, withExtension: nil),
               FileManager.default.isExecutableFile(atPath: bundled.path) {
                return bundled.path
            }
            #endif
        }

        return nil
    }

    private static func executablePath(named name: String, candidates: [String]) -> String? {
        var safeCandidates = candidates
        safeCandidates.append(contentsOf: [
            "/opt/homebrew/bin/\(name)",
            "/usr/local/bin/\(name)",
            "/usr/bin/\(name)",
            "/opt/local/bin/\(name)"
        ])

        for candidate in safeCandidates {
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    private static func extractOptions(from metadata: MediaMetadata) -> [CleanFormatOption] {
        var options: [CleanFormatOption] = []
        let rawFormats = metadata.formats ?? []

        let standardResolutions = [
            (2160, "4K"),
            (1440, "1440p"),
            (1080, "1080p"),
            (720, "720p"),
            (480, "480p"),
            (360, "360p")
        ]

        let availableResolutions = standardResolutions.filter { resolution, _ in
            rawFormats.contains { format in
                isVideo(format) && (format.height ?? 0) > 0 && (format.height ?? 0) <= resolution && (format.height ?? 0) >= resolution - 100
            }
        }
        let videoQualities = [(nil as Int?, "Best")] + availableResolutions.map { (Optional($0.0), $0.1) }
        let videoContainers = [
            ("mp4", "MP4"),
            ("mkv", "MKV"),
            ("webm", "WebM")
        ]

        for (height, qualityName) in videoQualities {
            for (container, containerName) in videoContainers {
                guard hasVideoFormat(rawFormats, height: height, container: container) else { continue }
                let estimatedBytes = estimatedVideoBytes(rawFormats, height: height, container: container)
                options.append(CleanFormatOption(
                    name: "\(qualityName) \(containerName)",
                    formatSelector: videoSelector(height: height, container: container),
                    isAudioOnly: false,
                    symbol: "play.tv.fill",
                    outputExtension: container,
                    detail: optionDetail(
                        base: height == nil ? "Best available video" : "Up to \(qualityName)",
                        estimatedBytes: estimatedBytes
                    ),
                    estimatedBytes: estimatedBytes,
                    mediaType: .video,
                    qualityName: qualityName,
                    containerName: containerName
                ))
            }
        }

        if hasAudioFormat(rawFormats, preferredExtension: nil) {
            let estimatedBytes = estimatedAudioBytes(rawFormats, preferredExtension: nil)
            options.append(CleanFormatOption(
                name: "Audio MP3",
                formatSelector: "bestaudio/best",
                isAudioOnly: true,
                symbol: "music.note",
                outputExtension: "mp3",
                detail: optionDetail(base: "Converted with ffmpeg", estimatedBytes: estimatedBytes),
                estimatedBytes: estimatedBytes,
                mediaType: .audio,
                qualityName: "Best",
                containerName: "MP3"
            ))
        }

        if hasAudioFormat(rawFormats, preferredExtension: "m4a") {
            let estimatedBytes = estimatedAudioBytes(rawFormats, preferredExtension: "m4a")
            options.append(CleanFormatOption(
                name: "Audio M4A",
                formatSelector: "bestaudio[ext=m4a]/bestaudio/best",
                isAudioOnly: true,
                symbol: "waveform",
                outputExtension: "m4a",
                detail: optionDetail(base: "Prefer native M4A", estimatedBytes: estimatedBytes),
                estimatedBytes: estimatedBytes,
                mediaType: .audio,
                qualityName: "Best",
                containerName: "M4A"
            ))
        }

        if hasAudioFormat(rawFormats, preferredExtension: "webm") {
            let estimatedBytes = estimatedAudioBytes(rawFormats, preferredExtension: "webm")
            options.append(CleanFormatOption(
                name: "Audio Opus",
                formatSelector: "bestaudio[ext=webm]/bestaudio/best",
                isAudioOnly: true,
                symbol: "waveform",
                outputExtension: "opus",
                detail: optionDetail(base: "Efficient audio", estimatedBytes: estimatedBytes),
                estimatedBytes: estimatedBytes,
                mediaType: .audio,
                qualityName: "Best",
                containerName: "Opus"
            ))
        }

        return options
    }

    private static func hasVideoFormat(_ formats: [RawMediaFormat], height: Int?, container: String) -> Bool {
        formats.contains { format in
            guard isVideo(format), matchesHeight(format, height: height) else { return false }
            return container == "mkv" || format.ext?.caseInsensitiveCompare(container) == .orderedSame
        }
    }

    private static func hasAudioFormat(_ formats: [RawMediaFormat], preferredExtension: String?) -> Bool {
        formats.contains { format in
            guard isAudio(format) else { return false }
            guard let preferredExtension else { return true }
            return format.ext?.caseInsensitiveCompare(preferredExtension) == .orderedSame
        }
    }

    private static func estimatedVideoBytes(_ formats: [RawMediaFormat], height: Int?, container: String) -> Int64? {
        let videoBytes = formats
            .filter { format in
                guard isVideo(format), matchesHeight(format, height: height) else { return false }
                return container == "mkv" || format.ext?.caseInsensitiveCompare(container) == .orderedSame
            }
            .compactMap { formatSize($0) }
            .max()

        guard let videoBytes else { return nil }
        let audioBytes = estimatedAudioBytes(formats, preferredExtension: container == "webm" ? "webm" : "m4a") ??
            estimatedAudioBytes(formats, preferredExtension: nil) ??
            0
        return videoBytes + audioBytes
    }

    private static func estimatedAudioBytes(_ formats: [RawMediaFormat], preferredExtension: String?) -> Int64? {
        let preferred = formats
            .filter { format in
                guard isAudio(format) else { return false }
                guard let preferredExtension else { return true }
                return format.ext?.caseInsensitiveCompare(preferredExtension) == .orderedSame
            }
            .compactMap { formatSize($0) }
            .max()

        if preferred != nil || preferredExtension == nil {
            return preferred
        }

        return estimatedAudioBytes(formats, preferredExtension: nil)
    }

    private static func isVideo(_ format: RawMediaFormat) -> Bool {
        guard let vcodec = format.vcodec?.lowercased(), vcodec != "none" else { return false }
        return true
    }

    private static func isAudio(_ format: RawMediaFormat) -> Bool {
        let acodec = format.acodec?.lowercased()
        let vcodec = format.vcodec?.lowercased()
        return acodec != nil && acodec != "none" && (vcodec == nil || vcodec == "none")
    }

    private static func matchesHeight(_ format: RawMediaFormat, height: Int?) -> Bool {
        guard let height else { return true }
        guard let formatHeight = format.height else { return false }
        return formatHeight <= height && formatHeight >= height - 100
    }

    private static func formatSize(_ format: RawMediaFormat) -> Int64? {
        format.filesize ?? format.filesize_approx
    }

    private static func optionDetail(base: String, estimatedBytes: Int64?) -> String {
        guard let estimatedBytes, estimatedBytes > 0 else { return base }
        return "\(base) - ~\(ByteFormatter.string(estimatedBytes))"
    }

    private static func videoSelector(height: Int?, container: String) -> String {
        let filter = heightFilter(height)
        switch container {
        case "mp4":
            return "bestvideo\(filter)[ext=mp4]+bestaudio[ext=m4a]/best\(filter)[ext=mp4]/bestvideo\(filter)+bestaudio/best\(filter)"
        case "webm":
            return "bestvideo\(filter)[ext=webm]+bestaudio[ext=webm]/best\(filter)[ext=webm]/bestvideo\(filter)+bestaudio/best\(filter)"
        default:
            return "bestvideo\(filter)+bestaudio/best\(filter)"
        }
    }

    private static func heightFilter(_ height: Int?) -> String {
        guard let height else { return "" }
        return "[height<=\(height)]"
    }
}

private final class YTDLPMetadataProcess: @unchecked Sendable {
    private let executableURL: URL
    private let arguments: [String]
    private let lock = NSLock()
    private var process: Process?

    init(executableURL: URL, arguments: [String]) {
        self.executableURL = executableURL
        self.arguments = arguments
    }

    func run(timeoutSeconds: UInt64) async throws -> Data {
        try await withTaskCancellationHandler {
            try await withThrowingTaskGroup(of: Data.self) { group in
                group.addTask {
                    try await self.runProcess()
                }
                group.addTask {
                    try await Task.sleep(for: .seconds(timeoutSeconds))
                    self.terminate()
                    throw MediaExtractionEngine.ExtractionError.timedOut
                }

                guard let result = try await group.next() else {
                    throw MediaExtractionEngine.ExtractionError.invalidOutput
                }
                group.cancelAll()
                return result
            }
        } onCancel: {
            self.terminate()
        }
    }

    private func runProcess() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            let outputPipe = Pipe()
            let errorPipe = Pipe()
            let outputBuffer = LockedDataBuffer(maxBytes: 64 * 1024 * 1024)
            let errorBuffer = LockedDataBuffer()

            process.executableURL = executableURL
            process.arguments = arguments
            process.standardOutput = outputPipe
            process.standardError = errorPipe
            process.standardInput = nil

            outputPipe.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                if data.isEmpty {
                    handle.readabilityHandler = nil
                } else {
                    outputBuffer.append(data)
                }
            }

            errorPipe.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                if data.isEmpty {
                    handle.readabilityHandler = nil
                } else {
                    errorBuffer.append(data)
                }
            }

            lock.withLock {
                self.process = process
            }

            process.terminationHandler = { finishedProcess in
                // Allow a brief moment for final pipe data to flush
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.25) {
                    outputPipe.fileHandleForReading.readabilityHandler = nil
                    errorPipe.fileHandleForReading.readabilityHandler = nil
                    if finishedProcess.terminationStatus == 0 {
                        continuation.resume(returning: outputBuffer.data)
                    } else {
                        let stderr = String(data: errorBuffer.data, encoding: .utf8)?
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                        let stdout = String(data: outputBuffer.data, encoding: .utf8)?
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                        let message = [stderr, stdout]
                            .compactMap { $0 }
                            .filter { !$0.isEmpty }
                            .joined(separator: "\n")
                        continuation.resume(
                            throwing: MediaExtractionEngine.ExtractionError.processFailed(
                                message.isEmpty ? "Exit code \(finishedProcess.terminationStatus)" : message
                            )
                        )
                    }
                }
            }

            do {
                try process.run()
                if Task.isCancelled {
                    self.terminate()
                }
                outputPipe.fileHandleForWriting.closeFile()
                errorPipe.fileHandleForWriting.closeFile()
            } catch {
                outputPipe.fileHandleForReading.readabilityHandler = nil
                errorPipe.fileHandleForReading.readabilityHandler = nil
                // We do not care about the DispatchGroup if we throw immediately here
                continuation.resume(throwing: MediaExtractionEngine.ExtractionError.processFailed(error.localizedDescription))
            }
        }
    }

    private func terminate() {
        let p = lock.withLock { self.process }
        guard let p, p.isRunning else { return }
        ProcessTreeTerminator.terminate(p)
    }
}
