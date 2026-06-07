import Foundation
import Combine

enum AddonState: Equatable, Sendable {
    case notInstalled
    case downloading(progress: Double)
    case installed(version: String)
    case failed(error: String)
}

enum AddonType: String, CaseIterable, Sendable {
    case ytDlp = "yt-dlp"
    case ffmpeg

    var defaultsKey: String {
        return "Firelink.AddonVersion.\(self.rawValue)"
    }

    var binaryName: String {
        switch self {
        case .ytDlp: return "yt-dlp"
        case .ffmpeg: return "ffmpeg"
        }
    }
}

@MainActor
final class MediaEngineManager: ObservableObject {
    static let shared = MediaEngineManager()

    @Published var ytDlpState: AddonState = .notInstalled
    @Published var ffmpegState: AddonState = .notInstalled

    private let configURL = URL(string: "https://nimbold.github.io/Firelink/firelink-addons.json")!

    private var addonsDirectory: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let bundleID = Bundle.main.bundleIdentifier ?? "com.firelink.app"
        return appSupport.appendingPathComponent(bundleID).appendingPathComponent("Addons", isDirectory: true)
    }

    private init() {
        checkLocalInstallation()
    }

    func binaryPath(for addon: AddonType) -> URL {
        return addonsDirectory.appendingPathComponent(addon.binaryName)
    }

    func checkLocalInstallation() {
        for addon in AddonType.allCases {
            let path = binaryPath(for: addon)
            if FileManager.default.isExecutableFile(atPath: path.path) {
                if let version = UserDefaults.standard.string(forKey: addon.defaultsKey) {
                    setState(for: addon, to: .installed(version: version))
                } else {
                    setState(for: addon, to: .installed(version: "Unknown"))
                }
            } else {
                setState(for: addon, to: .notInstalled)
            }
        }
    }

    func fetchLatestConfig() async throws -> GatekeeperConfig {
        var request = URLRequest(url: configURL)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 30

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, (200...299).contains(httpResponse.statusCode) else {
            throw URLError(.badServerResponse)
        }

        return try JSONDecoder().decode(GatekeeperConfig.self, from: data)
    }

    func ensureInstalled() async throws {
        // Simple helper for the "Extract" button flow
        // Fetches config and installs if not installed or out of date
        let config = try await fetchLatestConfig()

        // Use task group to download both if needed
        try await withThrowingTaskGroup(of: Void.self) { group in
            if case .notInstalled = ytDlpState {
                group.addTask { try await self.install(addon: .ytDlp, from: config) }
            } else if case .failed = ytDlpState {
                group.addTask { try await self.install(addon: .ytDlp, from: config) }
            } else if case let .installed(version) = ytDlpState, let configVersion = config.ytDlp?.version, version != configVersion {
                group.addTask { try await self.install(addon: .ytDlp, from: config) }
            }

            if case .notInstalled = ffmpegState {
                group.addTask { try await self.install(addon: .ffmpeg, from: config) }
            } else if case .failed = ffmpegState {
                group.addTask { try await self.install(addon: .ffmpeg, from: config) }
            } else if case let .installed(version) = ffmpegState, let configVersion = config.ffmpeg?.version, version != configVersion {
                group.addTask { try await self.install(addon: .ffmpeg, from: config) }
            }

            try await group.waitForAll()
        }
    }

    func install(addon: AddonType, from config: GatekeeperConfig) async throws {
        setState(for: addon, to: .downloading(progress: 0))

        let addonConfig: AddonConfig? = {
            switch addon {
            case .ytDlp: return config.ytDlp
            case .ffmpeg: return config.ffmpeg
            }
        }()

        guard let addonConfig = addonConfig else {
            setState(for: addon, to: .failed(error: "Missing configuration for \(addon.rawValue)"))
            throw URLError(.badURL)
        }

        guard let downloadURL = addonConfig.currentArchURL else {
            setState(for: addon, to: .failed(error: "No download URL for current architecture"))
            throw URLError(.badURL)
        }

        guard downloadURL.scheme?.lowercased() == "https" else {
            setState(for: addon, to: .failed(error: "Add-on URL must use HTTPS"))
            throw URLError(.badURL)
        }

        do {
            try FileManager.default.createDirectory(at: addonsDirectory, withIntermediateDirectories: true, attributes: nil)
            let destination = binaryPath(for: addon)

            try await BinaryDownloader.download(
                from: downloadURL,
                to: destination,
                expectedSHA256: addonConfig.currentArchSHA256
            ) { progress in
                Task { @MainActor in
                    self.setState(for: addon, to: .downloading(progress: progress))
                }
            }

            UserDefaults.standard.set(addonConfig.version, forKey: addon.defaultsKey)
            setState(for: addon, to: .installed(version: addonConfig.version))

        } catch {
            setState(for: addon, to: .failed(error: error.localizedDescription))
            throw error
        }
    }

    private func setState(for addon: AddonType, to state: AddonState) {
        switch addon {
        case .ytDlp: ytDlpState = state
        case .ffmpeg: ffmpegState = state
        }
    }
}
