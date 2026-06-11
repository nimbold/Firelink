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
        let ytDlpURL = await MediaEngineManager.shared.preparedBinaryPath(for: .ytDlp)
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
            "--no-check-formats",
            "--socket-timeout", "20",
            "--retries", "3",
            "--extractor-retries", "3",
            "--fragment-retries", "10",
            "--retry-sleep", "0",
            "--skip-unavailable-fragments",
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

        let tempConfigDir = MediaExtractionEngine.appendCommonArguments(
            to: &arguments,
            cookieSource: cookieSource,
            credentials: item.credentials,
            transferOptions: item.transferOptions,
            preferredDenoURL: ytDlpURL.deletingLastPathComponent().appendingPathComponent("deno")
        )

        if let proxyURI = proxyConfiguration.customProxyURI, proxyConfiguration.mode == .custom {
            arguments.append(contentsOf: ["--proxy", proxyURI])
        }

        if let speedLimitKiBPerSecond, speedLimitKiBPerSecond > 0 {
            arguments.append(contentsOf: ["--limit-rate", "\(speedLimitKiBPerSecond)K"])
        }

        appendParallelDownloadArguments(
            to: &arguments,
            item: item,
            speedLimitKiBPerSecond: speedLimitKiBPerSecond
        )

        arguments.append(item.url.absoluteString)
        process.arguments = arguments

        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe

        let parser = YTDLPProgressParser(totalExpectedBytes: item.sizeBytes)
        let errorBuffer = LockedDataBuffer()
        let outputPathTracker = YTDLPOutputPathTracker()
        let completionGate = CompletionGate(completion)
        let outputHandler = YTDLPOutputHandler(
            parser: parser,
            outputPathTracker: outputPathTracker,
            progress: progress,
            messageUpdate: messageUpdate
        )

        let readGroup = DispatchGroup()

        readGroup.enter()
        outputPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                readGroup.leave()
            } else if let text = String(data: data, encoding: .utf8) {
                outputHandler.handle(text)
            }
        }

        readGroup.enter()
        errorPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                readGroup.leave()
            } else {
                errorBuffer.append(data)
                if let text = String(data: data, encoding: .utf8) {
                    outputHandler.handle(text)
                }
            }
        }

        process.terminationHandler = { finishedProcess in
            if let tempConfigDir {
                try? FileManager.default.removeItem(at: tempConfigDir)
            }
            let complete: @Sendable () -> Void = {
                if finishedProcess.terminationStatus == 0 {
                    completionGate.complete(.success(Self.resolvedOutputURL(for: item, tracker: outputPathTracker)))
                } else {
                    let errorString = String(data: errorBuffer.data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "Unknown Error"
                    completionGate.complete(.failure(EngineError.launchFailed(Self.cleanErrorMessage(errorString, status: finishedProcess.terminationStatus))))
                }
            }
            readGroup.notify(queue: .global(), execute: complete)
            DispatchQueue.global().asyncAfter(deadline: .now() + 1) {
                outputPipe.fileHandleForReading.readabilityHandler = nil
                errorPipe.fileHandleForReading.readabilityHandler = nil
                complete()
            }
        }

        var didRun = false
        defer {
            if !didRun, let tempConfigDir {
                try? FileManager.default.removeItem(at: tempConfigDir)
            }
        }
        try process.run()
        didRun = true
        messageUpdate("Fetching media data...")
        outputPipe.fileHandleForWriting.closeFile()
        errorPipe.fileHandleForWriting.closeFile()

        return Handle(cancel: {
            if process.isRunning {
                ProcessTreeTerminator.terminate(process)
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

    private func appendParallelDownloadArguments(
        to arguments: inout [String],
        item: DownloadItem,
        speedLimitKiBPerSecond: Int?
    ) {
        let connections = min(max(item.connectionsPerServer, 1), 16)
        guard connections > 1 else { return }

        arguments.append(contentsOf: ["--concurrent-fragments", "\(connections)"])
        let largeDirectDownloadThreshold: Int64 = 128 * 1024 * 1024
        guard item.isAudioOnlyMedia != true,
              (item.sizeBytes ?? 0) >= largeDirectDownloadThreshold,
              speedLimitKiBPerSecond == nil,
              let aria2URL = Aria2DownloadEngine.findExecutable() else {
            return
        }

        let aria2Connections = min(connections, 8)
        let certificateArgument = Aria2DownloadEngine.certificateBundleURL().map {
            " --ca-certificate=\(Self.shellQuoted($0.path))"
        } ?? ""
        arguments.append(contentsOf: [
            "--downloader", aria2URL.path,
            "--downloader", "dash,m3u8:native",
            "--downloader-args",
            "aria2c:-x\(aria2Connections) -s\(aria2Connections) -k1M --file-allocation=none --summary-interval=1\(certificateArgument)"
        ])
    }

    private static func shellQuoted(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
    }
}

final class YTDLPOutputHandler: @unchecked Sendable {
    private let parser: YTDLPProgressParser
    private let outputPathTracker: YTDLPOutputPathTracker
    private let progress: @Sendable (DownloadProgress) -> Void
    private let messageUpdate: @Sendable (String) -> Void
    private var trackCount = 0

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
            if let message = statusMessage(for: stringLine) {
                messageUpdate(message)
            } else if let update = parser.parse(stringLine) {
                progress(update)
            }
        }
    }

    private func statusMessage(for line: String) -> String? {
        if line.contains("[Merger]") || line.contains("[ExtractAudio]") || line.contains("[Fixup") {
            return "Merging Media Tracks..."
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
            return "Downloading Media"
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

    private let totalExpectedBytes: Int64?
    private var accumulatedBytes: Int64 = 0
    private var currentFileBytes: Int64 = 0
    private var lastFraction: Double = 0

    init(totalExpectedBytes: Int64?) {
        self.totalExpectedBytes = totalExpectedBytes
    }

    private func processCumulativeProgress(
        fraction: Double,
        parsedSize: Int64,
        sizeStr: String
    ) -> (overallFraction: Double, displaySizeStr: String) {
        if fraction < lastFraction && lastFraction > 0.95 {
            accumulatedBytes += currentFileBytes
        }
        
        currentFileBytes = parsedSize
        lastFraction = fraction
        
        let totalDownloadedBytes = accumulatedBytes + Int64(Double(parsedSize) * fraction)
        let overallTotalBytes = max(totalExpectedBytes ?? 0, accumulatedBytes + parsedSize)
        
        var overallFraction = fraction
        var displaySizeStr = sizeStr
        
        if overallTotalBytes > 0 {
            overallFraction = Double(totalDownloadedBytes) / Double(overallTotalBytes)
            displaySizeStr = ByteFormatter.string(overallTotalBytes)
        }
        
        return (overallFraction, displaySizeStr)
    }

    private func parseBytes(_ sizeStr: String) -> Int64 {
        let clean = sizeStr.replacingOccurrences(of: "~", with: "").trimmingCharacters(in: .whitespaces)
        guard let regex = try? NSRegularExpression(pattern: #"^([0-9.]+)([a-zA-Z]+)$"#) else { return 0 }
        let nsString = clean as NSString
        guard let match = regex.firstMatch(in: clean, range: NSRange(location: 0, length: clean.count)),
              match.numberOfRanges == 3 else { return 0 }
        
        let numStr = nsString.substring(with: match.range(at: 1))
        let unitStr = nsString.substring(with: match.range(at: 2)).lowercased()
        
        guard let value = Double(numStr) else { return 0 }
        
        switch unitStr {
        case "b": return Int64(value)
        case "k", "kb", "kib": return Int64(value * 1024)
        case "m", "mb", "mib": return Int64(value * 1024 * 1024)
        case "g", "gb", "gib": return Int64(value * 1024 * 1024 * 1024)
        default: return Int64(value)
        }
    }

    func parse(_ line: String) -> DownloadProgress? {
        if line.contains("[download]") && line.contains("%") {
            let fraction = (Double(firstCapture(in: line, regex: percentageRegex) ?? "0") ?? 0) / 100.0
            let speed = firstCapture(in: line, regex: speedRegex) ?? "-"
            let eta = firstCapture(in: line, regex: etaRegex) ?? "-"
            let size = firstCapture(in: line, regex: sizeRegex) ?? "-"

            let parsedSize = parseBytes(size)
            let cumulative = processCumulativeProgress(fraction: fraction, parsedSize: parsedSize, sizeStr: size)

            return DownloadProgress(
                fraction: min(max(cumulative.overallFraction, 0), 1),
                bytesText: cumulative.displaySizeStr,
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

            let parsedSize = parseBytes(size)
            let cumulative = processCumulativeProgress(fraction: fraction, parsedSize: parsedSize, sizeStr: size)

            return DownloadProgress(
                fraction: min(max(cumulative.overallFraction, 0), 1),
                bytesText: cumulative.displaySizeStr,
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
