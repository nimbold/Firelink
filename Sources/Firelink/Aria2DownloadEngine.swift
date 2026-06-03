import Foundation
import CFNetwork

final class Aria2DownloadEngine {
    struct Handle {
        let processIdentifier: Int32
        let cancel: @Sendable () -> Void
    }

    enum EngineError: LocalizedError {
        case executableNotFound
        case launchFailed(String)
        case unsupportedProxy(String)

        var errorDescription: String? {
            switch self {
            case .executableNotFound:
                "aria2c was not found. Install it with `brew install aria2`, or bundle aria2c inside the app resources."
            case .launchFailed(let details):
                "Could not start aria2c: \(details)"
            case .unsupportedProxy(let details):
                details
            }
        }
    }

    private let executableURL: URL?

    init(executableURL: URL? = Aria2DownloadEngine.findExecutable()) {
        self.executableURL = executableURL
    }

    static func findExecutable() -> URL? {
        let candidates = [
            "/opt/homebrew/bin/aria2c",
            "/usr/local/bin/aria2c",
            "/usr/bin/aria2c"
        ]

        if let found = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            return URL(fileURLWithPath: found)
        }

        let path = ProcessInfo.processInfo.environment["PATH"] ?? ""
        for folder in path.split(separator: ":") {
            let candidate = URL(fileURLWithPath: String(folder)).appendingPathComponent("aria2c")
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }

        if let bundled = Bundle.main.url(forResource: "aria2c", withExtension: nil),
           FileManager.default.isExecutableFile(atPath: bundled.path) {
            return bundled
        }

        return nil
    }

    static func versionString() -> String? {
        guard let executableURL = findExecutable() else { return nil }

        let process = Process()
        let outputPipe = Pipe()
        process.executableURL = executableURL
        process.arguments = ["--version"]
        process.standardOutput = outputPipe
        process.standardError = Pipe()

        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }

            let data = outputPipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""
            return output
                .split(whereSeparator: { $0 == "\n" || $0 == "\r" })
                .first
                .map(String.init)
        } catch {
            return nil
        }
    }

    func start(
        item: DownloadItem,
        proxyConfiguration: DownloadProxyConfiguration,
        progress: @escaping @Sendable (DownloadProgress) -> Void,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    ) throws -> Handle {
        guard let executableURL else {
            throw EngineError.executableNotFound
        }

        try FileManager.default.createDirectory(
            at: item.destinationDirectory,
            withIntermediateDirectories: true
        )

        let process = Process()
        process.executableURL = executableURL
        process.arguments = try arguments(for: item, proxyConfiguration: proxyConfiguration)

        let inputPipe = Pipe()
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardInput = inputPipe
        process.standardOutput = outputPipe
        process.standardError = errorPipe

        let parser = Aria2ProgressParser()
        let outputBuffer = LockedDataBuffer()
        let errorBuffer = LockedDataBuffer()

        outputPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            outputBuffer.append(data)
            if let text = String(data: data, encoding: .utf8) {
                for update in parser.parse(text) {
                    progress(update)
                }
            }
        }

        errorPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            errorBuffer.append(data)
        }

        process.terminationHandler = { finishedProcess in
            outputPipe.fileHandleForReading.readabilityHandler = nil
            errorPipe.fileHandleForReading.readabilityHandler = nil

            if finishedProcess.terminationStatus == 0 {
                completion(.success(()))
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
            completion(.failure(EngineError.launchFailed(message.isEmpty ? "exit code \(finishedProcess.terminationStatus)" : message)))
        }

        do {
            try process.run()
            if let input = inputFileContent(for: item).data(using: .utf8) {
                inputPipe.fileHandleForWriting.write(input)
            }
            inputPipe.fileHandleForWriting.closeFile()
        } catch {
            throw EngineError.launchFailed(error.localizedDescription)
        }

        return Handle(processIdentifier: process.processIdentifier) {
            if process.isRunning {
                process.terminate()
            }
        }
    }

    private func arguments(for item: DownloadItem, proxyConfiguration: DownloadProxyConfiguration) throws -> [String] {
        var arguments = [
            "--continue=true",
            "--allow-overwrite=false",
            "--auto-file-renaming=true",
            "--summary-interval=1",
            "--console-log-level=warn",
            "--download-result=hide",
            "--file-allocation=none",
            "--min-split-size=1M",
            "--max-tries=10",
            "--retry-wait=5",
            "--connect-timeout=30",
            "--timeout=60",
            "--uri-selector=adaptive",
            "--input-file=-"
        ]

        arguments.append(contentsOf: try proxyArguments(for: item, configuration: proxyConfiguration))
        return arguments
    }

    private func proxyArguments(for item: DownloadItem, configuration: DownloadProxyConfiguration) throws -> [String] {
        switch configuration.mode {
        case .none:
            return clearedProxyArguments()
        case .system:
            switch systemProxyResolution(for: item.url) {
            case .direct:
                return clearedProxyArguments()
            case .proxy(let proxyURI):
                return ["\(proxyArgumentName(for: item.url.scheme))=\(sanitizedOptionValue(proxyURI))"]
            case .unsupported(let message):
                throw EngineError.unsupportedProxy(message)
            }
        case .custom:
            guard let proxyURI = configuration.customProxyURI else { return [] }
            return ["--all-proxy=\(sanitizedOptionValue(proxyURI))"]
        }
    }

    private func clearedProxyArguments() -> [String] {
        [
            "--all-proxy=",
            "--http-proxy=",
            "--https-proxy=",
            "--ftp-proxy="
        ]
    }

    private func proxyArgumentName(for urlScheme: String?) -> String {
        switch urlScheme?.lowercased() {
        case "http": "--http-proxy"
        case "https": "--https-proxy"
        case "ftp": "--ftp-proxy"
        default: "--all-proxy"
        }
    }

    private enum SystemProxyResolution {
        case direct
        case proxy(String)
        case unsupported(String)
    }

    private func systemProxyResolution(for url: URL) -> SystemProxyResolution {
        guard let systemSettings = CFNetworkCopySystemProxySettings()?.takeRetainedValue() as? [String: Any],
              let proxies = CFNetworkCopyProxiesForURL(url as CFURL, systemSettings as CFDictionary).takeRetainedValue() as? [[String: Any]] else {
            return .direct
        }

        for proxy in proxies {
            guard let type = proxy[kCFProxyTypeKey as String] as? String else { continue }
            if type == kCFProxyTypeNone as String {
                return .direct
            }
            if type == kCFProxyTypeSOCKS as String {
                return .unsupported("aria2c does not support SOCKS system proxies. Choose an HTTP, HTTPS, or FTP proxy in Network settings.")
            }
            if type == kCFProxyTypeAutoConfigurationURL as String ||
                type == kCFProxyTypeAutoConfigurationJavaScript as String {
                return .unsupported("aria2c does not support automatic system proxy configuration. Choose a manual proxy in Network settings.")
            }
            if let uri = proxyURI(fromSystemProxy: proxy, type: type) {
                return .proxy(uri)
            }
        }

        return .direct
    }

    private func proxyURI(fromSystemProxy proxy: [String: Any], type: String) -> String? {
        guard let host = proxy[kCFProxyHostNameKey as String] as? String,
              !host.isEmpty else {
            return nil
        }

        let port = (proxy[kCFProxyPortNumberKey as String] as? NSNumber)?.intValue
        let scheme: String
        if type == kCFProxyTypeHTTPS as String {
            scheme = "https"
        } else if type == kCFProxyTypeFTP as String {
            scheme = "ftp"
        } else {
            scheme = "http"
        }

        guard let port else {
            return "\(scheme)://\(host)"
        }
        return "\(scheme)://\(host):\(port)"
    }

    private func inputFileContent(for item: DownloadItem) -> String {
        let connections = min(max(item.connectionsPerServer, 1), 16)
        let urls = ([item.url] + (item.mirrorURLs ?? []))
            .map { sanitizedOptionValue($0.absoluteString) }
            .joined(separator: "\t")
        var lines = [
            urls,
            "  dir=\(sanitizedOptionValue(item.destinationDirectory.path))",
            "  out=\(sanitizedOptionValue(item.fileName))",
            "  split=\(connections)",
            "  max-connection-per-server=\(connections)"
        ]

        if let checksum = item.checksum?.normalized, !checksum.isEmpty {
            lines.append("  checksum=\(checksum.algorithm.rawValue)=\(sanitizedOptionValue(checksum.value))")
        }

        for header in (item.requestHeaders ?? []).map(\.normalized) where !header.isEmpty {
            lines.append("  header=\(sanitizedOptionValue(header.headerLine))")
        }

        if let cookieHeader = item.cookieHeader?.trimmingCharacters(in: .whitespacesAndNewlines), !cookieHeader.isEmpty {
            lines.append("  header=Cookie: \(sanitizedOptionValue(cookieHeader))")
        }

        if let credentials = item.credentials, !credentials.isEmpty {
            let scheme = item.url.scheme?.lowercased()
            if scheme == "ftp" || scheme == "sftp" {
                lines.append("  ftp-user=\(sanitizedOptionValue(credentials.username))")
                lines.append("  ftp-passwd=\(sanitizedOptionValue(credentials.password))")
            } else {
                lines.append("  http-user=\(sanitizedOptionValue(credentials.username))")
                lines.append("  http-passwd=\(sanitizedOptionValue(credentials.password))")
                lines.append("  http-auth-challenge=true")
            }
        }

        return lines.joined(separator: "\n") + "\n"
    }

    private func sanitizedOptionValue(_ value: String) -> String {
        value.replacingOccurrences(of: "\r", with: "")
            .replacingOccurrences(of: "\n", with: "")
    }
}

final class LockedDataBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = Data()

    var data: Data {
        lock.withLock { storage }
    }

    func append(_ data: Data) {
        lock.withLock {
            storage.append(data)
        }
    }
}

final class Aria2ProgressParser: @unchecked Sendable {
    private let percentageRegex = try? NSRegularExpression(pattern: #"\((\d+(?:\.\d+)?)%\)"#)
    private let connectionRegex = try? NSRegularExpression(pattern: #"CN:(\d+)"#)
    private let speedRegex = try? NSRegularExpression(pattern: #"DL:([^\s\]]+)"#)
    private let etaRegex = try? NSRegularExpression(pattern: #"ETA:([^\s\]]+)"#)
    private let bytesRegex = try? NSRegularExpression(pattern: #"\s([0-9.]+(?:KiB|MiB|GiB|TiB|B)?/[0-9.]+(?:KiB|MiB|GiB|TiB|B)?)\("#)

    func parse(_ text: String) -> [DownloadProgress] {
        text
            .split(whereSeparator: { $0 == "\n" || $0 == "\r" })
            .compactMap { parseLine(String($0)) }
    }

    private func parseLine(_ line: String) -> DownloadProgress? {
        guard line.contains("%") else { return nil }

        let percentage = firstCapture(in: line, regex: percentageRegex).flatMap(Double.init) ?? 0
        let connections = firstCapture(in: line, regex: connectionRegex).flatMap(Int.init) ?? 0
        let speed = firstCapture(in: line, regex: speedRegex) ?? "-"
        let eta = firstCapture(in: line, regex: etaRegex) ?? "-"
        let bytes = firstCapture(in: line, regex: bytesRegex) ?? "-"

        return DownloadProgress(
            fraction: min(max(percentage / 100, 0), 1),
            bytesText: bytes,
            speedText: speed,
            etaText: eta,
            connectionCount: connections
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
