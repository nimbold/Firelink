import Foundation

final class MediaDownloadEngine: @unchecked Sendable {
    struct Handle {
        let cancel: @Sendable () -> Void
    }

    enum EngineError: LocalizedError {
        case missingEngine(String)
        case launchFailed(String)

        var errorDescription: String? {
            switch self {
            case .missingEngine(let msg): return msg
            case .launchFailed(let msg): return msg
            }
        }
    }

    func start(
        item: DownloadItem,
        cookieSource: BrowserCookieSource,
        proxyConfiguration: DownloadProxyConfiguration,
        speedLimitKiBPerSecond: Int?,
        progress: @escaping @Sendable (DownloadProgress) -> Void,
        messageUpdate: @escaping @Sendable (String) -> Void,
        completion: @escaping @Sendable (Result<URL, Error>) -> Void
    ) async throws -> Handle {
        let ytDlpURL = await MediaEngineManager.shared.binaryPath(for: .ytDlp)
        let ffmpegURL = await MediaEngineManager.shared.binaryPath(for: .ffmpeg)

        guard let ytDlpURL, FileManager.default.isExecutableFile(atPath: ytDlpURL.path) else {
            throw EngineError.missingEngine("The bundled yt-dlp executable is missing. Reinstall Firelink or rebuild the app bundle.")
        }
        guard let ffmpegURL, FileManager.default.isExecutableFile(atPath: ffmpegURL.path) else {
            throw EngineError.missingEngine("The bundled FFmpeg executable is missing. Reinstall Firelink or rebuild the app bundle.")
        }

        try FileManager.default.createDirectory(at: item.destinationDirectory, withIntermediateDirectories: true)

        let process = Process()
        process.executableURL = ytDlpURL

        var arguments = [
            "--newline",
            "--ffmpeg-location", ffmpegURL.path,
            "--force-ipv4",
            "--live-from-start",
            "--extractor-args", "youtube:player_client=ios,web",
            "--compat-options", "no-youtube-unavailable-videos",
            "-o", item.destinationPath
        ]

        if let format = item.mediaFormatSelector {
            arguments.append("-f")
            arguments.append(format)

            if item.isAudioOnlyMedia == true {
                let audioFormat = item.fileName.fileExtension(defaultValue: "mp3")
                arguments.append(contentsOf: ["-x", "--audio-format", audioFormat, "--audio-quality", "0"])
            } else {
                let mergeFormat = item.fileName.fileExtension(defaultValue: "mp4")
                arguments.append(contentsOf: ["--merge-output-format", mergeFormat])
            }
        }

        MediaExtractionEngine.appendCommonArguments(
            to: &arguments,
            cookieSource: cookieSource,
            credentials: item.credentials,
            transferOptions: item.transferOptions
        )

        if let proxyURI = proxyConfiguration.customProxyURI, proxyConfiguration.mode == .custom {
            arguments.append(contentsOf: ["--proxy", proxyURI])
        }

        if let speedLimitKiBPerSecond, speedLimitKiBPerSecond > 0 {
            arguments.append(contentsOf: ["--limit-rate", "\(speedLimitKiBPerSecond)K"])
        }

        appendParallelDownloadArguments(to: &arguments, connectionsPerServer: item.connectionsPerServer)

        arguments.append(item.url.absoluteString)
        process.arguments = arguments

        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe

        let parser = YTDLPProgressParser()
        let errorBuffer = LockedDataBuffer()
        let outputPathTracker = YTDLPOutputPathTracker()
        let completionGate = CompletionGate(completion)
        let outputHandler = YTDLPOutputHandler(
            parser: parser,
            outputPathTracker: outputPathTracker,
            progress: progress,
            messageUpdate: messageUpdate
        )

        let group = DispatchGroup()
        group.enter() // output
        group.enter() // error
        group.enter() // process

        outputPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                group.leave()
            } else if let text = String(data: data, encoding: .utf8) {
                outputHandler.handle(text)
            }
        }

        errorPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                group.leave()
            } else {
                errorBuffer.append(data)
                if let text = String(data: data, encoding: .utf8) {
                    outputHandler.handle(text)
                }
            }
        }

        process.terminationHandler = { _ in
            group.leave()
        }

        group.notify(queue: .global()) {
            if process.terminationStatus == 0 {
                completionGate.complete(.success(Self.resolvedOutputURL(for: item, tracker: outputPathTracker)))
            } else {
                let errorString = String(data: errorBuffer.data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "Unknown Error"
                completionGate.complete(.failure(EngineError.launchFailed(Self.cleanErrorMessage(errorString, status: process.terminationStatus))))
            }
        }

        try process.run()
        messageUpdate("Fetching media data...")
        outputPipe.fileHandleForWriting.closeFile()
        errorPipe.fileHandleForWriting.closeFile()

        return Handle(cancel: {
            if process.isRunning {
                process.terminate()
            }
        })
    }

    private static func resolvedOutputURL(for item: DownloadItem, tracker: YTDLPOutputPathTracker) -> URL {
        let expectedURL = URL(fileURLWithPath: item.destinationPath)
        if FileManager.default.fileExists(atPath: expectedURL.path) {
            return expectedURL
        }

        if let observedURL = tracker.lastExistingOutputURL {
            return observedURL
        }

        let baseName = expectedURL.deletingPathExtension().lastPathComponent
        let commonExtensions = ["mp4", "mkv", "webm", "mp3", "m4a", "opus", "m4v", "aac", "wav", "flac"]
        
        var mostRecent: URL?
        var mostRecentDate: Date = .distantPast
        
        for ext in commonExtensions {
            let candidate = item.destinationDirectory.appendingPathComponent("\(baseName).\(ext)")
            if FileManager.default.fileExists(atPath: candidate.path) {
                let date = (try? candidate.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                if date >= mostRecentDate {
                    mostRecentDate = date
                    mostRecent = candidate
                }
            }
        }

        return mostRecent ?? expectedURL
    }

    private static func cleanErrorMessage(_ message: String, status: Int32) -> String {
        guard !message.isEmpty else {
            return "Exit code \(status)"
        }

        if message.localizedCaseInsensitiveContains("Sign in to confirm") ||
            message.localizedCaseInsensitiveContains("not a bot") ||
            message.localizedCaseInsensitiveContains("Use --cookies-from-browser") {
            return "YouTube requires browser cookies for this video. Choose a browser in Settings > Engine, then retry."
        }

        if message.localizedCaseInsensitiveContains("n challenge solving failed") ||
            message.localizedCaseInsensitiveContains("supported JavaScript runtime") {
            return "YouTube challenge solving failed. Install Deno or Node, then retry."
        }

        return message
    }

    private func appendParallelDownloadArguments(to arguments: inout [String], connectionsPerServer: Int) {
        let connections = min(max(connectionsPerServer, 1), 16)
        guard connections > 1 else { return }

        arguments.append(contentsOf: ["--concurrent-fragments", "\(connections)"])
        // Use yt-dlp's native concurrent downloader instead of aria2c to ensure progress parsing works via stdout
    }
}

final class YTDLPOutputHandler: @unchecked Sendable {
    private let parser: YTDLPProgressParser
    private let outputPathTracker: YTDLPOutputPathTracker
    private let progress: @Sendable (DownloadProgress) -> Void
    private let messageUpdate: @Sendable (String) -> Void

    init(
        parser: YTDLPProgressParser,
        outputPathTracker: YTDLPOutputPathTracker,
        progress: @escaping @Sendable (DownloadProgress) -> Void,
        messageUpdate: @escaping @Sendable (String) -> Void
    ) {
        self.parser = parser
        self.outputPathTracker = outputPathTracker
        self.progress = progress
        self.messageUpdate = messageUpdate
    }

    func handle(_ text: String) {
        for line in text.split(whereSeparator: \.isNewline) {
            let stringLine = String(line)
            outputPathTracker.observe(stringLine)
            if let update = parser.parse(stringLine) {
                progress(update)
                messageUpdate("Downloading Media")
            } else if let message = statusMessage(for: stringLine) {
                messageUpdate(message)
            }
        }
    }

    private func statusMessage(for line: String) -> String? {
        if line.contains("[Merger]") || line.contains("[ExtractAudio]") || line.contains("[Fixup") {
            return "Processing Media..."
        }
        if line.contains("[youtube]") && line.localizedCaseInsensitiveContains("Downloading") {
            return "Fetching YouTube data..."
        }
        if line.contains("[info]") && line.localizedCaseInsensitiveContains("Downloading") {
            return "Preparing media stream..."
        }
        if line.localizedCaseInsensitiveContains("Sign in to confirm") ||
            line.localizedCaseInsensitiveContains("not a bot") ||
            line.localizedCaseInsensitiveContains("Use --cookies-from-browser") {
            return "YouTube requires browser cookies"
        }
        if line.localizedCaseInsensitiveContains("n challenge solving failed") ||
            line.localizedCaseInsensitiveContains("supported JavaScript runtime") {
            return "YouTube challenge solver unavailable"
        }
        if line.contains("Destination:") {
            return "Starting media download..."
        }
        return nil
    }
}

final class YTDLPOutputPathTracker: @unchecked Sendable {
    private let lock = NSLock()
    private var observedPaths: [String] = []
    private let quotedPathRegex = try? NSRegularExpression(pattern: #""([^"]+)""#)

    var lastExistingOutputURL: URL? {
        lock.withLock {
            observedPaths
                .reversed()
                .map { URL(fileURLWithPath: $0) }
                .first { FileManager.default.fileExists(atPath: $0.path) }
        }
    }

    func observe(_ line: String) {
        let candidates = pathCandidates(from: line)
        guard !candidates.isEmpty else { return }

        lock.withLock {
            for candidate in candidates where !observedPaths.contains(candidate) {
                observedPaths.append(candidate)
            }
        }
    }

    private func pathCandidates(from line: String) -> [String] {
        var paths: [String] = []

        if line.contains("Destination:"),
           let destination = line.components(separatedBy: "Destination:").last?.trimmingCharacters(in: .whitespacesAndNewlines),
           destination.hasPrefix("/") {
            paths.append(destination.trimmingCharacters(in: CharacterSet(charactersIn: "\"")))
        }

        for quoted in quotedCaptures(in: line) where quoted.hasPrefix("/") {
            paths.append(quoted)
        }

        return paths
    }

    private func quotedCaptures(in text: String) -> [String] {
        guard let quotedPathRegex else { return [] }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return quotedPathRegex.matches(in: text, range: range).compactMap { match in
            guard match.numberOfRanges > 1,
                  let captureRange = Range(match.range(at: 1), in: text) else {
                return nil
            }
            return String(text[captureRange])
        }
    }
}

private extension String {
    func fileExtension(defaultValue: String) -> String {
        let ext = (self as NSString).pathExtension.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return ext.isEmpty ? defaultValue : ext
    }
}

final class YTDLPProgressParser: @unchecked Sendable {
    private let percentageRegex = try? NSRegularExpression(pattern: #"(\d+(?:\.\d+)?)%"#)
    private let speedRegex = try? NSRegularExpression(pattern: #"at\s+([^\s]+)"#)
    private let etaRegex = try? NSRegularExpression(pattern: #"ETA\s+([^\s]+)"#)
    private let sizeRegex = try? NSRegularExpression(pattern: #"of\s+~?([0-9.]+[a-zA-Z]+)"#)

    func parse(_ line: String) -> DownloadProgress? {
        if line.contains("[download]") && line.contains("%") {
            let fraction = (Double(firstCapture(in: line, regex: percentageRegex) ?? "0") ?? 0) / 100.0
            let speed = firstCapture(in: line, regex: speedRegex) ?? "-"
            let eta = firstCapture(in: line, regex: etaRegex) ?? "-"
            let size = firstCapture(in: line, regex: sizeRegex) ?? "-"

            return DownloadProgress(
                fraction: min(max(fraction, 0), 1),
                bytesText: size,
                speedText: speed,
                etaText: eta,
                connectionCount: 1
            )
        } else if line.contains("[#") && line.contains("DL:") {
            let fraction = (Double(firstCapture(in: line, regex: try? NSRegularExpression(pattern: #"\(([\d.]+)%\)"#)) ?? "0") ?? 0) / 100.0
            let speed = firstCapture(in: line, regex: try? NSRegularExpression(pattern: #"DL:([^\s\]]+)"#)) ?? "-"
            let eta = firstCapture(in: line, regex: try? NSRegularExpression(pattern: #"ETA:([^\]]+)"#)) ?? "-"
            let size = firstCapture(in: line, regex: try? NSRegularExpression(pattern: #"/([^\s\(]+)\("#)) ?? "-"
            let cn = Int(firstCapture(in: line, regex: try? NSRegularExpression(pattern: #"CN:(\d+)"#)) ?? "1") ?? 1

            return DownloadProgress(
                fraction: min(max(fraction, 0), 1),
                bytesText: size,
                speedText: speed,
                etaText: eta,
                connectionCount: cn
            )
        }
        return nil
    }

    private func firstCapture(in text: String, regex: NSRegularExpression?) -> String? {
        guard let regex else { return nil }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, range: range), match.numberOfRanges > 1 else {
            return nil
        }
        guard let captureRange = Range(match.range(at: 1), in: text) else {
            return nil
        }
        return String(text[captureRange])
    }
}
