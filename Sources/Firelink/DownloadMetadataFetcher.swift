import Foundation

enum DownloadURLParser {
    private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    static func parse(_ text: String) -> [URL] {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        let detected = detector?.matches(in: text, range: range).compactMap(\.url) ?? []

        let tokenized = text
            .components(separatedBy: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ",;")))
            .compactMap { token -> URL? in
                let trimmed = token.trimmingCharacters(in: CharacterSet(charactersIn: "\"'<>[]()"))
                guard let url = URL(string: trimmed),
                      let scheme = url.scheme?.lowercased(),
                      ["http", "https", "ftp", "sftp"].contains(scheme) else {
                    return nil
                }
                return url
            }

        var seen = Set<String>()
        return (detected + tokenized).filter { url in
            guard let scheme = url.scheme?.lowercased(),
                  ["http", "https", "ftp", "sftp"].contains(scheme) else {
                return false
            }
            return seen.insert(url.absoluteString).inserted
        }
    }
}

enum DownloadMetadataFetcher {
    static func fetch(
        for url: URL,
        settings: AppSettings,
        credentials: DownloadCredentials? = nil,
        transferOptions: DownloadTransferOptions = DownloadTransferOptions(),
        isAutoFetch: Bool = false
    ) async -> PendingDownload {
        let initialName = FileClassifier.fileName(from: url)
        let initialCategory = FileClassifier.category(forFileName: initialName)
        let initialDirectory = await settings.destinationDirectory(for: initialCategory)
        var pending = PendingDownload(
            url: url,
            fileName: initialName,
            category: initialCategory,
            defaultDirectory: initialDirectory,
            state: .loading
        )

        guard url.scheme?.lowercased().hasPrefix("http") == true else {
            pending.state = .loaded
            return pending
        }

        if isAutoFetch, let host = url.host, isPrivateHost(host) {
            pending.state = .loaded
            return pending
        }

        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        request.timeoutInterval = 12
        request.setValue("Firelink/0.1", forHTTPHeaderField: "User-Agent")

        let normalizedHeaders = transferOptions.requestHeaders.map(\.normalized).filter { !$0.isEmpty }
        let hasAuthorizationHeader = normalizedHeaders.contains { $0.name.caseInsensitiveCompare("Authorization") == .orderedSame }
        if let credentials, !credentials.isEmpty, !hasAuthorizationHeader {
            let token = "\(credentials.username):\(credentials.password)"
                .data(using: .utf8)?
                .base64EncodedString()
            if let token {
                request.setValue("Basic \(token)", forHTTPHeaderField: "Authorization")
            }
        }

        for header in normalizedHeaders {
            request.setValue(header.value, forHTTPHeaderField: header.name)
        }
        if let cookieHeader = transferOptions.cookieHeader?.trimmingCharacters(in: .whitespacesAndNewlines), !cookieHeader.isEmpty {
            request.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
        }

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                pending.state = .loaded
                return pending
            }

            if let disposition = httpResponse.value(forHTTPHeaderField: "Content-Disposition"),
               let fileName = fileName(fromContentDisposition: disposition) {
                pending.fileName = FileClassifier.sanitizedFileName(fileName)
                pending.category = FileClassifier.category(forFileName: pending.fileName)
                pending.defaultDirectory = await settings.destinationDirectory(for: pending.category)
            }

            if let contentLength = httpResponse.value(forHTTPHeaderField: "Content-Length"),
               let bytes = Int64(contentLength) {
                pending.sizeBytes = bytes
            } else if response.expectedContentLength > 0 {
                pending.sizeBytes = response.expectedContentLength
            }

            pending.mimeType = httpResponse.mimeType
            pending.state = .loaded
        } catch {
            pending.state = .failed(error.localizedDescription)
        }

        return pending
    }

    private static func fileName(fromContentDisposition header: String) -> String? {
        let parts = header.components(separatedBy: ";")
        for part in parts {
            let trimmed = part.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.lowercased().hasPrefix("filename*="),
               let value = trimmed.components(separatedBy: "''").last?.removingPercentEncoding {
                return value.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            }

            if trimmed.lowercased().hasPrefix("filename=") {
                return String(trimmed.dropFirst("filename=".count))
                    .trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            }
        }
        return nil
    }

    private static func isPrivateHost(_ host: String) -> Bool {
        let h = host.lowercased()
        if h == "localhost" || h.hasSuffix(".local") { return true }
        if !h.contains(".") && !h.contains(":") { return true }

        let parts = h.split(separator: ".")
        if parts.count == 4, let first = Int(parts[0]), let second = Int(parts[1]) {
            if first == 127 || first == 10 || (first == 192 && second == 168) {
                return true
            }
            if first == 172 && (16...31).contains(second) {
                return true
            }
            if first == 169 && second == 254 {
                return true
            }
        }

        if h.contains(":") {
            if h == "[::1]" || h.hasPrefix("[fc") || h.hasPrefix("[fd") || h.hasPrefix("[fe8") || h.hasPrefix("[fe9") || h.hasPrefix("[fea") || h.hasPrefix("[feb") {
                return true
            }
        }
        return false
    }
}

enum ByteFormatter {
    static func string(_ bytes: Int64?) -> String {
        guard let bytes else { return "Unknown" }
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        formatter.includesUnit = true
        formatter.includesCount = true
        return formatter.string(fromByteCount: bytes)
    }
}
