import Foundation

enum DownloadStatus: String, Codable, CaseIterable, Sendable {
    case queued = "Queued"
    case downloading = "Downloading"
    case paused = "Paused"
    case completed = "Completed"
    case failed = "Failed"
    case canceled = "Canceled"
}

enum DownloadCategory: String, Codable, CaseIterable, Sendable {
    case musics = "Musics"
    case movies = "Movies"
    case compressed = "Compressed"
    case pictures = "Pictures"
    case documents = "Documents"
    case other = "Other"

    var symbolName: String {
        switch self {
        case .musics: "music.note"
        case .movies: "film"
        case .compressed: "archivebox"
        case .pictures: "photo"
        case .documents: "doc.text"
        case .other: "folder"
        }
    }
}

struct DownloadQueue: Identifiable, Codable, Equatable, Sendable {
    static let mainQueueID = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!

    var id = UUID()
    var name: String

    var isMain: Bool {
        id == Self.mainQueueID
    }

    static var main: DownloadQueue {
        DownloadQueue(id: mainQueueID, name: "Main queue")
    }
}

struct DownloadCredentials: Codable, Equatable, Sendable {
    var username: String
    var password: String

    var isEmpty: Bool {
        username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            password.isEmpty
    }
}

enum ChecksumAlgorithm: String, Codable, CaseIterable, Identifiable, Sendable {
    case md5
    case sha1 = "sha-1"
    case sha256 = "sha-256"
    case sha512 = "sha-512"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .md5: "MD5"
        case .sha1: "SHA-1"
        case .sha256: "SHA-256"
        case .sha512: "SHA-512"
        }
    }
}

struct DownloadChecksum: Codable, Equatable, Sendable {
    var algorithm: ChecksumAlgorithm
    var value: String

    var normalized: DownloadChecksum {
        DownloadChecksum(
            algorithm: algorithm,
            value: value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        )
    }

    var isEmpty: Bool {
        value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

struct DownloadRequestHeader: Codable, Equatable, Sendable {
    var name: String
    var value: String

    var normalized: DownloadRequestHeader {
        DownloadRequestHeader(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            value: value.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    var isEmpty: Bool {
        let clean = normalized
        return clean.name.isEmpty && clean.value.isEmpty
    }

    var headerLine: String {
        let clean = normalized
        return "\(clean.name): \(clean.value)"
    }
}

struct DownloadTransferOptions: Equatable, Sendable {
    var checksum: DownloadChecksum?
    var requestHeaders: [DownloadRequestHeader] = []
    var cookieHeader: String?
    var mirrorURLs: [URL] = []
}

enum DownloadTransferOptionParser {
    static func parseHeaders(_ text: String) -> [DownloadRequestHeader] {
        headerLines(text).compactMap { line in
            guard let colonIndex = line.firstIndex(of: ":") else { return nil }
            let name = String(line[..<colonIndex]).trimmingCharacters(in: .whitespacesAndNewlines)
            let value = String(line[line.index(after: colonIndex)...]).trimmingCharacters(in: .whitespacesAndNewlines)
            let header = DownloadRequestHeader(name: name, value: value).normalized
            return header.isEmpty || header.name.isEmpty ? nil : header
        }
    }

    static func invalidHeaderLines(_ text: String) -> [String] {
        headerLines(text).filter { line in
            guard let colonIndex = line.firstIndex(of: ":") else { return true }
            let name = String(line[..<colonIndex]).trimmingCharacters(in: .whitespacesAndNewlines)
            return name.isEmpty
        }
    }

    static func cleanCookieHeader(_ text: String) -> String? {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.lowercased().hasPrefix("cookie:") {
            value = String(value.dropFirst("cookie:".count)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return value.isEmpty ? nil : value
    }

    static func parseMirrorURLs(_ text: String) -> [URL] {
        DownloadURLParser.parse(text)
    }

    static func invalidMirrorLines(_ text: String) -> [String] {
        text.split(whereSeparator: { $0 == "\n" || $0 == "\r" })
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && DownloadURLParser.parse($0).isEmpty }
    }

    private static func headerLines(_ text: String) -> [String] {
        text.split(whereSeparator: { $0 == "\n" || $0 == "\r" })
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }
}

struct DownloadItem: Identifiable, Codable, Equatable, Sendable {
    var id = UUID()
    var url: URL
    var fileName: String
    var category: DownloadCategory
    var destinationDirectory: URL
    var connectionsPerServer: Int
    var credentials: DownloadCredentials?
    var checksum: DownloadChecksum?
    var requestHeaders: [DownloadRequestHeader]?
    var cookieHeader: String?
    var mirrorURLs: [URL]?
    var speedLimitKiBPerSecond: Int?
    var status: DownloadStatus = .queued
    var progress: Double = 0
    var speedText: String = "-"
    var etaText: String = "-"
    var connectionCount: Int = 0
    var sizeBytes: Int64?
    var bytesText: String = "-"
    var message: String = ""
    var createdAt = Date()
    var lastTryAt: Date?
    var autoResumeOnLaunch: Bool?
    var queueID: UUID?

    var destinationPath: String {
        destinationDirectory.appendingPathComponent(fileName).path
    }

    var transferOptions: DownloadTransferOptions {
        DownloadTransferOptions(
            checksum: checksum,
            requestHeaders: requestHeaders ?? [],
            cookieHeader: cookieHeader,
            mirrorURLs: mirrorURLs ?? []
        )
    }

    var speedLimitText: String {
        guard let speedLimitKiBPerSecond, speedLimitKiBPerSecond > 0 else {
            return "No limit"
        }
        return "\(speedLimitKiBPerSecond) KiB/s"
    }

    var redactedForPersistence: DownloadItem {
        var item = self
        item.credentials = nil
        item.cookieHeader = nil
        item.requestHeaders = item.requestHeaders?.filter { !$0.containsSensitiveValue }
        return item
    }
}

private extension DownloadRequestHeader {
    var containsSensitiveValue: Bool {
        switch normalized.name.lowercased() {
        case "authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token":
            true
        default:
            false
        }
    }
}

struct DownloadProgress: Equatable, Sendable {
    var fraction: Double
    var bytesText: String
    var speedText: String
    var etaText: String
    var connectionCount: Int
}

struct PendingDownload: Identifiable, Equatable, Sendable {
    enum MetadataState: Equatable, Sendable {
        case pending
        case loading
        case loaded
        case failed(String)
    }

    var id = UUID()
    var url: URL
    var fileName: String
    var category: DownloadCategory
    var defaultDirectory: URL
    var sizeBytes: Int64?
    var mimeType: String?
    var state: MetadataState = .pending

    var destinationPath: String {
        defaultDirectory.appendingPathComponent(fileName).path
    }
}
