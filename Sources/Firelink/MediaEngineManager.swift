import Foundation
import Combine
import Darwin

enum AddonState: Equatable, Sendable {
    case notInstalled
    case installed(version: String)
    case failed(error: String)
}

enum AddonType: String, CaseIterable, Sendable {
    case ytDlp = "yt-dlp"
    case ffmpeg
    case deno

    var binaryName: String {
        switch self {
        case .ytDlp: return "yt-dlp"
        case .ffmpeg: return "ffmpeg"
        case .deno: return "deno"
        }
    }
}

@MainActor
final class MediaEngineManager: ObservableObject {
    static let shared = MediaEngineManager()

    @Published var ytDlpState: AddonState = .notInstalled
    @Published var ffmpegState: AddonState = .notInstalled
    @Published var denoState: AddonState = .notInstalled
    private var ytDlpPreparationTask: Task<URL?, Never>?

    private init() {
        checkLocalInstallation()
        Task { [weak self] in
            _ = await self?.preparedBinaryPath(for: .ytDlp)
        }
    }

    func preparedBinaryPath(for addon: AddonType) async -> URL? {
        guard addon == .ytDlp else { return binaryPath(for: addon) }

        if let ytDlpPreparationTask {
            return await ytDlpPreparationTask.value
        }

        guard let bundledURL = binaryPath(for: .ytDlp) else { return nil }
        let runtimeVersion = bundledRuntimeVersion(near: bundledURL)
        let task = Task<URL?, Never>.detached(priority: .userInitiated) {
            let executableURL = Self.installStableYtDlpRuntime(
                bundledExecutableURL: bundledURL,
                version: runtimeVersion
            ) ?? bundledURL
            Self.prewarm(executableURL)
            return executableURL
        }
        ytDlpPreparationTask = task
        return await task.value
    }

    func binaryPath(for addon: AddonType) -> URL? {
        if let bundled = Bundle.main.url(forResource: addon.binaryName, withExtension: nil),
           FileManager.default.isExecutableFile(atPath: bundled.path) {
            return bundled
        }
        
        // Prevent fatalError crash: avoid accessing Bundle.module if running in a packaged app.
        if Bundle.main.bundleURL.pathExtension.lowercased() != "app" {
            #if SWIFT_PACKAGE
            if let bundled = Bundle.module.url(forResource: addon.binaryName, withExtension: nil),
               FileManager.default.isExecutableFile(atPath: bundled.path) {
                return bundled
            }
            #endif
        }
        return nil
    }

    private func bundledRuntimeVersion(near executableURL: URL) -> String {
        let versionURL = executableURL.deletingLastPathComponent()
            .appendingPathComponent("yt-dlp-version.txt")
        if let version = try? String(contentsOf: versionURL, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !version.isEmpty {
            return version
        }

        return Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
    }

    nonisolated private static func installStableYtDlpRuntime(
        bundledExecutableURL: URL,
        version: String
    ) -> URL? {
        let fileManager = FileManager.default
        let bundledDirectory = bundledExecutableURL.deletingLastPathComponent()
        let bundledInternalURL = bundledDirectory.appendingPathComponent("_internal", isDirectory: true)
        let bundledDenoURL = bundledDirectory.appendingPathComponent("deno")
        let hasBundledDeno = fileManager.isExecutableFile(atPath: bundledDenoURL.path)

        guard fileManager.fileExists(atPath: bundledInternalURL.path) else {
            return bundledExecutableURL
        }

        guard let applicationSupportURL = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else {
            return bundledExecutableURL
        }

        let safeVersion = version.replacingOccurrences(
            of: #"[^A-Za-z0-9._-]"#,
            with: "_",
            options: .regularExpression
        )
        let enginesURL = applicationSupportURL
            .appendingPathComponent("Firelink", isDirectory: true)
            .appendingPathComponent("MediaEngines", isDirectory: true)
            .appendingPathComponent("yt-dlp", isDirectory: true)
        let runtimeURL = enginesURL.appendingPathComponent(safeVersion, isDirectory: true)
        let executableURL = runtimeURL.appendingPathComponent("yt-dlp")
        let internalURL = runtimeURL.appendingPathComponent("_internal", isDirectory: true)
        let denoURL = runtimeURL.appendingPathComponent("deno")

        if fileManager.isExecutableFile(atPath: executableURL.path),
           fileManager.fileExists(atPath: internalURL.path),
           !hasBundledDeno || fileManager.isExecutableFile(atPath: denoURL.path) {
            return executableURL
        }

        let temporaryURL = enginesURL.appendingPathComponent(
            ".install-\(UUID().uuidString)",
            isDirectory: true
        )

        do {
            try fileManager.createDirectory(at: enginesURL, withIntermediateDirectories: true)
            try fileManager.createDirectory(at: temporaryURL, withIntermediateDirectories: true)
            try fileManager.copyItem(
                at: bundledExecutableURL,
                to: temporaryURL.appendingPathComponent("yt-dlp")
            )
            try fileManager.copyItem(
                at: bundledInternalURL,
                to: temporaryURL.appendingPathComponent("_internal", isDirectory: true)
            )
            if hasBundledDeno {
                try fileManager.copyItem(
                    at: bundledDenoURL,
                    to: temporaryURL.appendingPathComponent("deno")
                )
            }
            removeTransportAttributesRecursively(at: temporaryURL)

            if fileManager.fileExists(atPath: runtimeURL.path) {
                try fileManager.removeItem(at: runtimeURL)
            }
            try fileManager.moveItem(at: temporaryURL, to: runtimeURL)
            return executableURL
        } catch {
            try? fileManager.removeItem(at: temporaryURL)
            return bundledExecutableURL
        }
    }

    nonisolated private static func removeTransportAttributesRecursively(at rootURL: URL) {
        removeTransportAttributes(at: rootURL)

        guard let enumerator = FileManager.default.enumerator(
            at: rootURL,
            includingPropertiesForKeys: nil,
            options: [],
            errorHandler: nil
        ) else {
            return
        }

        for case let itemURL as URL in enumerator {
            removeTransportAttributes(at: itemURL)
        }
    }

    nonisolated private static func removeTransportAttributes(at url: URL) {
        url.withUnsafeFileSystemRepresentation { path in
            guard let path else { return }
            removexattr(path, "com.apple.quarantine", 0)
            removexattr(path, "com.apple.provenance", 0)
        }
    }

    nonisolated private static func prewarm(_ executableURL: URL) {
        runVersionCommand(executableURL)

        let denoURL = executableURL.deletingLastPathComponent().appendingPathComponent("deno")
        if FileManager.default.isExecutableFile(atPath: denoURL.path) {
            runVersionCommand(denoURL)
        }
    }

    nonisolated private static func runVersionCommand(_ executableURL: URL) {
        let process = Process()
        process.executableURL = executableURL
        process.arguments = ["--version"]
        process.standardOutput = nil
        process.standardError = nil
        process.standardInput = nil

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return
        }
    }

    func checkLocalInstallation() {
        for addon in AddonType.allCases {
            if binaryPath(for: addon) != nil {
                setState(for: addon, to: .installed(version: "Bundled"))
            } else {
                setState(for: addon, to: .notInstalled)
            }
        }
    }

    func ensureAvailable(addons requiredAddons: Set<AddonType>) async throws {
        checkLocalInstallation()
        let missingAddons = requiredAddons.filter { addon in
            switch state(for: addon) {
            case .installed:
                return false
            case .notInstalled, .failed:
                return true
            }
        }

        guard !missingAddons.isEmpty else { return }

        for missing in missingAddons {
            setState(for: missing, to: .failed(error: "Bundled executable missing"))
        }

        throw NSError(domain: "MediaEngineErrorDomain", code: 1, userInfo: [NSLocalizedDescriptionKey: "One or more required media engines are missing from the app bundle. Reinstall Firelink or rebuild the app bundle."])
    }

    private func state(for addon: AddonType) -> AddonState {
        switch addon {
        case .ytDlp: return ytDlpState
        case .ffmpeg: return ffmpegState
        case .deno: return denoState
        }
    }

    private func setState(for addon: AddonType, to state: AddonState) {
        switch addon {
        case .ytDlp: ytDlpState = state
        case .ffmpeg: ffmpegState = state
        case .deno: denoState = state
        }
    }
}
