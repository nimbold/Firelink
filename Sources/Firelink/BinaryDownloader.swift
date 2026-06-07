import Foundation
import CryptoKit

enum BinaryDownloaderError: LocalizedError {
    case invalidResponse
    case httpError(statusCode: Int)
    case downloadFailed(Error?)
    case moveFailed(Error)
    case permissionFailed(Error)
    case unzipFailed
    case unsupportedDownloadURL
    case missingChecksum
    case checksumMismatch

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            "The add-on server returned an invalid response."
        case .httpError(let statusCode):
            "The add-on download failed with HTTP \(statusCode)."
        case .downloadFailed(let error):
            error?.localizedDescription ?? "The add-on download failed."
        case .moveFailed(let error):
            error.localizedDescription
        case .permissionFailed(let error):
            "Could not mark the add-on executable: \(error.localizedDescription)"
        case .unzipFailed:
            "Could not extract the downloaded add-on archive."
        case .unsupportedDownloadURL:
            "The add-on URL must be HTTP or HTTPS."
        case .missingChecksum:
            "The add-on configuration is missing a SHA-256 checksum."
        case .checksumMismatch:
            "The downloaded add-on did not match the expected SHA-256 checksum."
        }
    }
}

final class BinaryDownloader: NSObject, URLSessionDownloadDelegate, Sendable {
    private let url: URL
    private let destination: URL
    private let expectedSHA256: String?
    private let onProgress: @Sendable (Double) -> Void
    private let session: URLSession

    private let continuation: CheckedContinuation<Void, Error>

    init(
        url: URL,
        destination: URL,
        expectedSHA256: String?,
        onProgress: @escaping @Sendable (Double) -> Void,
        continuation: CheckedContinuation<Void, Error>
    ) {
        self.url = url
        self.destination = destination
        self.expectedSHA256 = expectedSHA256
        self.onProgress = onProgress
        self.continuation = continuation

        let config = URLSessionConfiguration.ephemeral
        self.session = URLSession(configuration: config, delegate: nil, delegateQueue: nil) // Delegate set below
        super.init()
    }

    static func download(
        from url: URL,
        to destination: URL,
        expectedSHA256: String? = nil,
        onProgress: @escaping @Sendable (Double) -> Void
    ) async throws {
        try await withCheckedThrowingContinuation { continuation in
            let downloader = BinaryDownloader(
                url: url,
                destination: destination,
                expectedSHA256: expectedSHA256,
                onProgress: onProgress,
                continuation: continuation
            )
            let session = URLSession(configuration: .ephemeral, delegate: downloader, delegateQueue: nil)
            let task = session.downloadTask(with: url)
            task.resume()
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        defer { session.finishTasksAndInvalidate() }
        guard let response = downloadTask.response as? HTTPURLResponse else {
            continuation.resume(throwing: BinaryDownloaderError.invalidResponse)
            return
        }
        guard (200...299).contains(response.statusCode) else {
            continuation.resume(throwing: BinaryDownloaderError.httpError(statusCode: response.statusCode))
            return
        }

        do {
            guard ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
                throw BinaryDownloaderError.unsupportedDownloadURL
            }

            let isZip = url.pathExtension.lowercased() == "zip"
            let stagingURL = destination
                .deletingLastPathComponent()
                .appendingPathComponent(".\(destination.lastPathComponent).\(UUID().uuidString).staged")
            var cleanupURLs: [URL] = [stagingURL]
            defer {
                for cleanupURL in cleanupURLs {
                    try? FileManager.default.removeItem(at: cleanupURL)
                }
            }

            if isZip {
                let tempZip = location.appendingPathExtension("zip")
                try FileManager.default.moveItem(at: location, to: tempZip)
                cleanupURLs.append(tempZip)

                let extractDir = tempZip.deletingLastPathComponent().appendingPathComponent("extracted_\(UUID().uuidString)")
                try FileManager.default.createDirectory(at: extractDir, withIntermediateDirectories: true)
                cleanupURLs.append(extractDir)

                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
                process.arguments = ["-q", tempZip.path, "-d", extractDir.path]
                try process.run()
                process.waitUntilExit()
                guard process.terminationStatus == 0 else {
                    throw BinaryDownloaderError.unzipFailed
                }

                let expectedName = destination.lastPathComponent
                var foundBinary: URL?
                if let enumerator = FileManager.default.enumerator(at: extractDir, includingPropertiesForKeys: nil) {
                    for case let fileURL as URL in enumerator {
                        if fileURL.lastPathComponent == expectedName || fileURL.lastPathComponent == expectedName + "c" {
                            foundBinary = fileURL
                            break
                        }
                    }
                }

                guard let foundBinary = foundBinary else {
                    throw BinaryDownloaderError.unzipFailed
                }

                try FileManager.default.moveItem(at: foundBinary, to: stagingURL)
            } else {
                try FileManager.default.moveItem(at: location, to: stagingURL)
            }

            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: stagingURL.path)
            if let expectedSHA256 {
                let actualSHA256 = try Self.sha256Hex(for: stagingURL)
                guard actualSHA256.caseInsensitiveCompare(expectedSHA256.trimmingCharacters(in: .whitespacesAndNewlines)) == .orderedSame else {
                    throw BinaryDownloaderError.checksumMismatch
                }
            }
            try installStagedBinary(stagingURL, at: destination)

            continuation.resume()
        } catch {
            continuation.resume(throwing: BinaryDownloaderError.moveFailed(error))
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard totalBytesExpectedToWrite > 0 else { return }
        let progress = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
        onProgress(progress)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error {
            session.finishTasksAndInvalidate()
            continuation.resume(throwing: BinaryDownloaderError.downloadFailed(error))
        }
    }

    private func installStagedBinary(_ stagedURL: URL, at destination: URL) throws {
        if FileManager.default.fileExists(atPath: destination.path) {
            _ = try FileManager.default.replaceItemAt(destination, withItemAt: stagedURL)
        } else {
            try FileManager.default.moveItem(at: stagedURL, to: destination)
        }
    }

    private static func sha256Hex(for url: URL) throws -> String {
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
