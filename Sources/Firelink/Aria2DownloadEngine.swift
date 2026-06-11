import Foundation
import CFNetwork
import Network

final class Aria2DownloadEngine: Sendable {
    struct Handle {
        let processIdentifier: Int32
        let rpcPort: Int
        let rpcSecret: String
        let cancel: @Sendable () -> Void
    }

    static func findFreePort() -> (UInt16, Int32)? {
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0

        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return nil }

        var addrPtr = addr
        let bindResult = withUnsafePointer(to: &addrPtr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }

        guard bindResult == 0 else {
            close(sock)
            return nil
        }

        var boundAddr = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let getsocknameResult = withUnsafeMutablePointer(to: &boundAddr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(sock, $0, &len)
            }
        }

        guard getsocknameResult == 0 else {
            close(sock)
            return nil
        }

        let port = UInt16(bigEndian: boundAddr.sin_port)
        return (port, sock)
    }

    enum EngineError: LocalizedError {
        case executableNotFound
        case launchFailed(String)
        case unsupportedProxy(String)

        var errorDescription: String? {
            switch self {
            case .executableNotFound:
                "The bundled aria2c runtime is missing. Reinstall Firelink or rebuild its media engines."
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
        bundledResource(named: "aria2c", executable: true)
    }

    static func certificateBundleURL() -> URL? {
        bundledResource(named: "aria2-cacert.pem", executable: false)
    }

    private static func bundledResource(named name: String, executable: Bool) -> URL? {
        func validResource(in bundle: Bundle) -> URL? {
            guard let url = bundle.resourceURL?.appendingPathComponent(name) else { return nil }
            let isValid = executable
                ? FileManager.default.isExecutableFile(atPath: url.path)
                : FileManager.default.fileExists(atPath: url.path)
            return isValid ? url : nil
        }

        if let bundled = validResource(in: .main) {
            return bundled
        }

        if Bundle.main.bundleURL.pathExtension.lowercased() != "app" {
            #if SWIFT_PACKAGE
            return validResource(in: .module)
            #endif
        }

        return nil
    }

    static func versionString() async -> String? {
        guard let executableURL = findExecutable() else { return nil }

        return await Task.detached {
            let process = Process()
            let outputPipe = Pipe()
            process.executableURL = executableURL
            process.arguments = ["--version"]
            process.standardOutput = outputPipe
            process.standardError = nil
            process.standardInput = nil // ensure no stdin is inherited that could cause blocking

            do {
                try process.run()
                // Close the write file handle in the parent process immediately
                // This guarantees readToEnd() won't hang waiting for the parent itself
                outputPipe.fileHandleForWriting.closeFile()

                let data = try? outputPipe.fileHandleForReading.readToEnd()
                process.waitUntilExit()

                guard process.terminationStatus == 0, let data = data else { return nil }

                let output = String(data: data, encoding: .utf8) ?? ""
                return output
                    .split(whereSeparator: { $0 == "\n" || $0 == "\r" })
                    .first
                    .map(String.init)
            } catch {
                return nil
            }
        }.value
    }

    func start(
        item: DownloadItem,
        proxyConfiguration: DownloadProxyConfiguration,
        speedLimitKiBPerSecond: Int?,
        progress: @escaping @Sendable (DownloadProgress) -> Void,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    ) async throws -> Handle {
        guard let executableURL else {
            throw EngineError.executableNotFound
        }

        try FileManager.default.createDirectory(
            at: item.destinationDirectory,
            withIntermediateDirectories: true
        )

        var lastError: Error?

        for _ in 1...5 {
            guard let (rpcPortVal, portSocket) = Self.findFreePort() else {
                lastError = EngineError.launchFailed("Could not find free port")
                continue
            }
            let rpcPort = Int(rpcPortVal)
            let rpcSecret = UUID().uuidString
            let tempDir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("firelink-aria2-\(UUID().uuidString)")
            
            final class CleanupState: @unchecked Sendable {
                private let lock = NSLock()
                private var didCleanup = false
                func cleanup(tempDir: URL) {
                    lock.lock()
                    defer { lock.unlock() }
                    if !didCleanup {
                        try? FileManager.default.removeItem(at: tempDir)
                        didCleanup = true
                    }
                }
            }
            
            let cleanupState = CleanupState()
            let cleanupTempDir: @Sendable () -> Void = {
                cleanupState.cleanup(tempDir: tempDir)
            }
            
            do {
                try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            } catch {
                close(portSocket)
                lastError = EngineError.launchFailed("Could not create secure temporary directory: \(error.localizedDescription)")
                continue
            }
            
            let confURL = tempDir.appendingPathComponent("aria2.conf")
            do {
                let confContent = "rpc-secret=\(rpcSecret)\n"
                try confContent.write(to: confURL, atomically: true, encoding: .utf8)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: confURL.path)
            } catch {
                close(portSocket)
                lastError = EngineError.launchFailed("Could not write secure configuration file: \(error.localizedDescription)")
                continue
            }

            let process = Process()
            process.executableURL = executableURL
            
            do {
                process.arguments = try arguments(
                    for: item,
                    proxyConfiguration: proxyConfiguration,
                    speedLimitKiBPerSecond: speedLimitKiBPerSecond,
                    rpcPort: rpcPort,
                    confURL: confURL
                )
            } catch {
                close(portSocket)
                lastError = error
                break
            }

            let inputPipe = Pipe()
            let outputPipe = Pipe()
            let errorPipe = Pipe()
        process.standardInput = inputPipe
        process.standardOutput = outputPipe
        process.standardError = errorPipe

        let parser = Aria2ProgressParser()
        let outputBuffer = LockedDataBuffer()
        let errorBuffer = LockedDataBuffer()
        let completionGate = CompletionGate(completion)
        let completionMonitor = CompletionMonitor()

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
            cleanupTempDir()
            completionMonitor.cancel()
            outputPipe.fileHandleForReading.readabilityHandler = nil
            errorPipe.fileHandleForReading.readabilityHandler = nil

            if finishedProcess.terminationStatus == 0 {
                completionGate.complete(.success(()))
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
            completionGate.complete(.failure(EngineError.launchFailed(message.isEmpty ? "exit code \(finishedProcess.terminationStatus)" : message)))
        }

            var didThrow = false
            do {
                close(portSocket)
                try process.run()
                if let input = inputFileContent(for: item).data(using: .utf8) {
                    inputPipe.fileHandleForWriting.write(input)
                }
                inputPipe.fileHandleForWriting.closeFile()
            } catch {
                didThrow = true
                lastError = EngineError.launchFailed(error.localizedDescription)
            }
            
            if didThrow {
                outputPipe.fileHandleForReading.readabilityHandler = nil
                errorPipe.fileHandleForReading.readabilityHandler = nil
                cleanupTempDir()
                continue
            }
            
            try? await Task.sleep(nanoseconds: 100_000_000)
            
            if !process.isRunning {
                let stderr = String(data: errorBuffer.data, encoding: .utf8) ?? ""
                if stderr.contains("Address already in use") || stderr.contains("Failed to bind") || stderr.contains("bind: Address") {
                    cleanupTempDir()
                    continue
                }
                // If it exited for another reason, we might still want to fail or let the terminationHandler process it.
                // But the terminationHandler will hit completionGate, so we just return the handle.
            }

            completionMonitor.set(
                Self.monitorCompletion(
                    rpcPort: rpcPort,
                    rpcSecret: rpcSecret,
                    process: process,
                    completionGate: completionGate
                )
            )

            return Handle(processIdentifier: process.processIdentifier, rpcPort: rpcPort, rpcSecret: rpcSecret) {
                completionMonitor.cancel()
                if process.isRunning {
                    ProcessTreeTerminator.terminate(process)
                }
                cleanupTempDir()
            }
        }
        
        throw lastError ?? EngineError.launchFailed("Failed to start aria2c after 5 attempts.")
    }

    private static func monitorCompletion(
        rpcPort: Int,
        rpcSecret: String,
        process: Process,
        completionGate: CompletionGate<Void>
    ) -> Task<Void, Never> {
        Task.detached {
            while !Task.isCancelled && process.isRunning {
                if await completedDownloadStatus(rpcPort: rpcPort, rpcSecret: rpcSecret) {
                    completionGate.complete(.success(()))
                    if process.isRunning {
                        ProcessTreeTerminator.terminate(process)
                    }
                    return
                }

                do {
                    try await Task.sleep(nanoseconds: 1_000_000_000)
                } catch {
                    return
                }
            }
        }
    }

    private static func completedDownloadStatus(rpcPort: Int, rpcSecret: String) async -> Bool {
        guard let stopped = await rpcCall(
            rpcPort: rpcPort,
            rpcSecret: rpcSecret,
            method: "aria2.tellStopped",
            arguments: [0, 10, ["status", "errorCode", "completedLength", "totalLength"]]
        ) as? [[String: Any]] else {
            return false
        }

        if stopped.contains(where: { item in
            (item["status"] as? String) == "complete"
        }) {
            return true
        }

        return stopped.contains { item in
            guard (item["status"] as? String) == "error",
                  (item["errorCode"] as? String) == "0",
                  let completedLength = Int64(item["completedLength"] as? String ?? ""),
                  let totalLength = Int64(item["totalLength"] as? String ?? ""),
                  totalLength > 0 else {
                return false
            }
            return completedLength >= totalLength
        }
    }

    private static func rpcCall(
        rpcPort: Int,
        rpcSecret: String,
        method: String,
        arguments: [Any]
    ) async -> Any? {
        guard let url = URL(string: "http://127.0.0.1:\(rpcPort)/jsonrpc") else { return nil }
        let payload: [String: Any] = [
            "jsonrpc": "2.0",
            "method": method,
            "id": UUID().uuidString,
            "params": ["token:\(rpcSecret)"] + arguments
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        request.timeoutInterval = 3

        guard let (responseData, _) = try? await URLSession.shared.data(for: request),
              let json = try? JSONSerialization.jsonObject(with: responseData) as? [String: Any] else {
            return nil
        }
        return json["result"]
    }

    static func updateSpeedLimit(handle: Handle, speedLimitKiBPerSecond: Int?) async {
        guard let url = URL(string: "http://127.0.0.1:\(handle.rpcPort)/jsonrpc") else { return }

        let limitValue = speedLimitKiBPerSecond.map { "\($0)K" } ?? "0"
        let payload: [String: Any] = [
            "jsonrpc": "2.0",
            "method": "aria2.changeGlobalOption",
            "id": UUID().uuidString,
            "params": [
                "token:\(handle.rpcSecret)",
                ["max-overall-download-limit": limitValue]
            ]
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        request.timeoutInterval = 3

        _ = try? await URLSession.shared.data(for: request)
    }

    private func arguments(
        for item: DownloadItem,
        proxyConfiguration: DownloadProxyConfiguration,
        speedLimitKiBPerSecond: Int?,
        rpcPort: Int,
        confURL: URL
    ) throws -> [String] {
        var arguments = [
            "--conf-path=\(confURL.path)",
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
            "--input-file=-",
            "--enable-rpc=true",
            "--rpc-listen-port=\(rpcPort)",
            "--rpc-listen-all=false"
        ]

        if let speedLimitKiBPerSecond, speedLimitKiBPerSecond > 0 {
            arguments.append("--max-overall-download-limit=\(speedLimitKiBPerSecond)K")
        }

        if let certificateBundleURL = Self.certificateBundleURL() {
            arguments.append("--ca-certificate=\(certificateBundleURL.path)")
        }

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
            "  out=\(sanitizedOptionValue(item.fileName.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "\\", with: "_")))",
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
    private let maxBytes: Int

    init(maxBytes: Int = 512 * 1024) {
        self.maxBytes = maxBytes
    }

    var data: Data {
        lock.withLock { storage }
    }

    func append(_ data: Data) {
        lock.withLock {
            storage.append(data)
            if storage.count > maxBytes {
                storage.removeFirst(storage.count - maxBytes)
            }
        }
    }
}

final class CompletionGate<Success>: @unchecked Sendable {
    private let lock = NSLock()
    private var didComplete = false
    private let completion: @Sendable (Result<Success, Error>) -> Void

    init(_ completion: @escaping @Sendable (Result<Success, Error>) -> Void) {
        self.completion = completion
    }

    func complete(_ result: Result<Success, Error>) {
        lock.lock()
        let shouldComplete = !didComplete
        if shouldComplete {
            didComplete = true
        }
        lock.unlock()

        guard shouldComplete else { return }
        completion(result)
    }
}

final class CompletionMonitor: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<Void, Never>?

    func set(_ task: Task<Void, Never>) {
        lock.lock()
        self.task = task
        lock.unlock()
    }

    func cancel() {
        lock.lock()
        let task = self.task
        self.task = nil
        lock.unlock()
        task?.cancel()
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
