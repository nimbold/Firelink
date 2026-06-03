import Foundation

enum DownloadURLParser {
    static func parse(_ text: String) -> [URL] {
        let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
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
        transferOptions: DownloadTransferOptions = DownloadTransferOptions()
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

        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        request.timeoutInterval = 12
        request.setValue("Firelink/0.1", forHTTPHeaderField: "User-Agent")
        for header in transferOptions.requestHeaders.map(\.normalized) where !header.isEmpty {
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
                pending.fileName = fileName
                pending.category = FileClassifier.category(forFileName: fileName)
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
