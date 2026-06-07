import Foundation

struct AddonConfig: Codable, Equatable, Sendable {
    let version: String
    let macArm64: URL?
    let macX64: URL?
    let macArm64SHA256: String?
    let macX64SHA256: String?
    
    enum CodingKeys: String, CodingKey {
        case version
        case macArm64 = "mac-arm64"
        case macX64 = "mac-x64"
        case macArm64SHA256 = "mac-arm64-sha256"
        case macX64SHA256 = "mac-x64-sha256"
    }
    
    /// Returns the appropriate download URL for the current system architecture
    var currentArchURL: URL? {
        #if arch(arm64)
        return macArm64
        #elseif arch(x86_64)
        return macX64
        #else
        return nil
        #endif
    }

    var currentArchSHA256: String? {
        #if arch(arm64)
        return macArm64SHA256
        #elseif arch(x86_64)
        return macX64SHA256
        #else
        return nil
        #endif
    }
}

struct GatekeeperConfig: Codable, Equatable, Sendable {
    let ytDlp: AddonConfig?
    let ffmpeg: AddonConfig?
    
    enum CodingKeys: String, CodingKey {
        case ytDlp = "yt-dlp"
        case ffmpeg
    }
}
