import Foundation

struct RawMediaFormat: Decodable, Sendable {
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

struct MediaMetadata: Decodable, Sendable {
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

struct CleanFormatOption: Identifiable, Equatable, Sendable {
    var id: String { name }
    let name: String
    let formatSelector: String
    let isAudioOnly: Bool
    let symbol: String
    let outputExtension: String
}

enum MediaExtractionEngine {
    private static let metadataTimeoutSeconds: UInt64 = 75

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
            case .timedOut: return "Fetching metadata timed out. Try again, update yt-dlp, or change the selected browser cookie source."
            }
        }
    }
    
    static func fetchMetadata(
        for url: URL,
        cookieSource: BrowserCookieSource,
        credentials: DownloadCredentials?,
        transferOptions: DownloadTransferOptions
    ) async throws -> (MediaMetadata, [CleanFormatOption]) {
        let ytDlpPath = await MediaEngineManager.shared.binaryPath(for: .ytDlp).path
        guard FileManager.default.isExecutableFile(atPath: ytDlpPath) else {
            throw ExtractionError.processFailed("yt-dlp binary not found.")
        }

        var args = ["-J", "--no-warnings", "--ignore-no-formats-error", "--no-playlist"]
        appendCommonArguments(to: &args, cookieSource: cookieSource, credentials: credentials, transferOptions: transferOptions)
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
            return (metadata, options)
        } catch {
            throw ExtractionError.parsingFailed(error)
        }
    }

    static func appendCommonArguments(
        to args: inout [String],
        cookieSource: BrowserCookieSource,
        credentials: DownloadCredentials?,
        transferOptions: DownloadTransferOptions
    ) {
        if let browserName = cookieSource.ytDlpBrowserName {
            args.append(contentsOf: ["--cookies-from-browser", browserName])
        }

        for header in transferOptions.requestHeaders.map(\.normalized) where !header.isEmpty {
            args.append(contentsOf: ["--add-header", header.headerLine])
        }

        if let cookieHeader = transferOptions.cookieHeader?.trimmingCharacters(in: .whitespacesAndNewlines),
           !cookieHeader.isEmpty {
            args.append(contentsOf: ["--add-header", "Cookie: \(cookieHeader)"])
        }

        if let credentials, !credentials.isEmpty {
            args.append(contentsOf: ["--username", credentials.username, "--password", credentials.password])
        }
    }
    
    private static func extractOptions(from metadata: MediaMetadata) -> [CleanFormatOption] {
        var options: [CleanFormatOption] = []
        let rawFormats = metadata.formats ?? []
        
        let heights = rawFormats.compactMap { $0.height }.filter { $0 > 0 }
        let maxHeight = heights.max() ?? 0
        
        let standardResolutions = [
            (2160, "4K"),
            (1440, "1440p"),
            (1080, "1080p"),
            (720, "720p"),
            (480, "480p"),
            (360, "360p")
        ]
        
        var addedResolutions = Set<Int>()
        
        for (res, name) in standardResolutions {
            if maxHeight >= res - 100 && !addedResolutions.contains(res) { // -100 for some leeway (e.g., 1000 instead of 1080)
                options.append(CleanFormatOption(
                    name: "Video \(name)",
                    formatSelector: "bestvideo[height<=\(res)]+bestaudio/best",
                    isAudioOnly: false,
                    symbol: "play.tv.fill",
                    outputExtension: "mp4"
                ))
                addedResolutions.insert(res)
            }
        }
        
        if options.isEmpty && maxHeight > 0 {
            // Fallback if no standard resolution matched
            options.append(CleanFormatOption(
                name: "Best Video",
                formatSelector: "bestvideo+bestaudio/best",
                isAudioOnly: false,
                symbol: "play.tv.fill",
                outputExtension: "mp4"
            ))
        } else if options.isEmpty {
            // If we really don't have height info, just offer best
            options.append(CleanFormatOption(
                name: "Default Video",
                formatSelector: "best",
                isAudioOnly: false,
                symbol: "play.tv.fill",
                outputExtension: "mp4"
            ))
        }
        
        // Add Audio options
        options.append(CleanFormatOption(
            name: "Audio MP3",
            formatSelector: "bestaudio/best", // Actual extraction to MP3 needs ffmpeg, which we have. We will handle the conversion flags later in the download engine.
            isAudioOnly: true,
            symbol: "music.note",
            outputExtension: "mp3"
        ))
        
        options.append(CleanFormatOption(
            name: "Audio M4A",
            formatSelector: "bestaudio[ext=m4a]/bestaudio/best",
            isAudioOnly: true,
            symbol: "waveform",
            outputExtension: "m4a"
        ))
        
        return options
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
                guard !data.isEmpty else { return }
                outputBuffer.append(data)
            }
            errorPipe.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                guard !data.isEmpty else { return }
                errorBuffer.append(data)
            }

            lock.withLock {
                self.process = process
            }

            process.terminationHandler = { finishedProcess in
                outputPipe.fileHandleForReading.readabilityHandler = nil
                errorPipe.fileHandleForReading.readabilityHandler = nil

                if finishedProcess.terminationStatus == 0 {
                    continuation.resume(returning: outputBuffer.data)
                    return
                }

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

            do {
                try process.run()
                outputPipe.fileHandleForWriting.closeFile()
                errorPipe.fileHandleForWriting.closeFile()
            } catch {
                outputPipe.fileHandleForReading.readabilityHandler = nil
                errorPipe.fileHandleForReading.readabilityHandler = nil
                continuation.resume(throwing: MediaExtractionEngine.ExtractionError.processFailed(error.localizedDescription))
            }
        }
    }

    private func terminate() {
        lock.withLock {
            if let process, process.isRunning {
                process.terminate()
            }
        }
    }
}
