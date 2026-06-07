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
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    ) async throws -> Handle {
        let ytDlpURL = await MediaEngineManager.shared.binaryPath(for: .ytDlp)
        let ffmpegURL = await MediaEngineManager.shared.binaryPath(for: .ffmpeg)
        
        guard FileManager.default.isExecutableFile(atPath: ytDlpURL.path) else {
            throw EngineError.missingEngine("yt-dlp is not installed. Please check Settings > Add-ons.")
        }
        guard FileManager.default.isExecutableFile(atPath: ffmpegURL.path) else {
            throw EngineError.missingEngine("ffmpeg is not installed. Please check Settings > Add-ons.")
        }
        
        try FileManager.default.createDirectory(at: item.destinationDirectory, withIntermediateDirectories: true)
        
        let process = Process()
        process.executableURL = ytDlpURL
        
        var arguments = [
            "--newline",
            "--ffmpeg-location", ffmpegURL.path,
            "-o", item.destinationPath
        ]
        
        if let format = item.mediaFormatSelector {
            arguments.append("-f")
            arguments.append(format)
            
            if item.isAudioOnlyMedia == true {
                let audioFormat = item.fileName.fileExtension(defaultValue: "mp3")
                arguments.append(contentsOf: ["-x", "--audio-format", audioFormat, "--audio-quality", "0"])
            } else {
                arguments.append(contentsOf: ["--merge-output-format", "mp4"])
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
        
        arguments.append(item.url.absoluteString)
        process.arguments = arguments
        
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe
        
        let parser = YTDLPProgressParser()
        let errorBuffer = LockedDataBuffer()
        let completionGate = CompletionGate(completion)
        
        outputPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            
            for line in text.split(whereSeparator: \.isNewline) {
                let stringLine = String(line)
                if let update = parser.parse(stringLine) {
                    progress(update)
                } else if stringLine.contains("[Merger]") || stringLine.contains("[ExtractAudio]") {
                    messageUpdate("Processing Media...")
                }
            }
        }

        errorPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            errorBuffer.append(data)
            if let text = String(data: data, encoding: .utf8) {
                for line in text.split(whereSeparator: \.isNewline) {
                    let stringLine = String(line)
                    if stringLine.contains("[Merger]") || stringLine.contains("[ExtractAudio]") {
                        messageUpdate("Processing Media...")
                    }
                }
            }
        }
        
        process.terminationHandler = { finishedProcess in
            outputPipe.fileHandleForReading.readabilityHandler = nil
            errorPipe.fileHandleForReading.readabilityHandler = nil
            
            if finishedProcess.terminationStatus == 0 {
                completionGate.complete(.success(()))
            } else {
                let errorString = String(data: errorBuffer.data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "Unknown Error"
                completionGate.complete(.failure(EngineError.launchFailed(errorString.isEmpty ? "Exit code \(finishedProcess.terminationStatus)" : errorString)))
            }
        }
        
        try process.run()
        outputPipe.fileHandleForWriting.closeFile()
        errorPipe.fileHandleForWriting.closeFile()
        
        return Handle(cancel: {
            if process.isRunning {
                process.terminate()
            }
        })
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
        guard line.contains("[download]") && line.contains("%") else { return nil }
        
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
