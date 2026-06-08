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

    private init() {
        checkLocalInstallation()
    }

    func binaryPath(for addon: AddonType) -> URL? {
        if let bundled = Bundle.main.url(forResource: addon.binaryName, withExtension: nil),
           FileManager.default.isExecutableFile(atPath: bundled.path) {
            return bundled
        }
        return nil
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
            case .downloading, .notInstalled, .failed:
                return true
            }
        }

        guard !missingAddons.isEmpty else { return }
        
        for missing in missingAddons {
            setState(for: missing, to: .failed(error: "Bundled executable missing"))
        }
        
        throw NSError(domain: "MediaEngineErrorDomain", code: 1, userInfo: [NSLocalizedDescriptionKey: "One or more required media engines are missing from the app bundle."])
    }

    private func state(for addon: AddonType) -> AddonState {
        switch addon {
        case .ytDlp: return ytDlpState
        case .ffmpeg: return ffmpegState
        }
    }

    private func setState(for addon: AddonType, to state: AddonState) {
        switch addon {
        case .ytDlp: ytDlpState = state
        case .ffmpeg: ffmpegState = state
        }
    }
}
