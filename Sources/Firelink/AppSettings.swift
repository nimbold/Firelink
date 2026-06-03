import Foundation

struct SiteLogin: Identifiable, Codable, Equatable, Sendable {
    var id = UUID()
    var urlPattern: String
    var username: String
}

enum ProxyMode: String, Codable, CaseIterable, Sendable {
    case none
    case system
    case custom

    var title: String {
        switch self {
        case .none: "No proxy"
        case .system: "Use system proxy"
        case .custom: "Set proxy"
        }
    }
}

enum ProxyType: String, Codable, CaseIterable, Sendable {
    case http
    case https
    case ftp

    var title: String {
        switch self {
        case .http: "HTTP"
        case .https: "HTTPS"
        case .ftp: "FTP"
        }
    }

    var uriScheme: String {
        rawValue
    }
}

struct ProxySettings: Codable, Equatable, Sendable {
    var mode: ProxyMode = .none
    var type: ProxyType = .http
    var host = ""
    var port = 8080

    var normalized: ProxySettings {
        var copy = self
        copy.host = copy.host.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.port = min(max(copy.port, 1), 65_535)
        return copy
    }

    var customProxyURI: String? {
        let clean = normalized
        guard !clean.host.isEmpty else { return nil }
        return "\(clean.type.uriScheme)://\(clean.host):\(clean.port)"
    }
}

struct DownloadProxyConfiguration: Equatable, Sendable {
    var mode: ProxyMode
    var customProxyURI: String?
}

@MainActor
final class AppSettings: ObservableObject {
    @Published var perServerConnections: Int {
        didSet {
            let clamped = min(max(perServerConnections, 1), 16)
            if perServerConnections != clamped {
                perServerConnections = clamped
            }
            save()
        }
    }

    @Published var maxConcurrentDownloads: Int {
        didSet {
            let clamped = min(max(maxConcurrentDownloads, 1), 12)
            if maxConcurrentDownloads != clamped {
                maxConcurrentDownloads = clamped
            }
            save()
        }
    }

    @Published var globalSpeedLimitKiBPerSecond: Int {
        didSet {
            let clamped = min(max(globalSpeedLimitKiBPerSecond, 0), 10_485_760)
            if globalSpeedLimitKiBPerSecond != clamped {
                globalSpeedLimitKiBPerSecond = clamped
                return
            }
            save()
        }
    }

    @Published var preventsSleepWhileDownloading: Bool {
        didSet { save() }
    }

    @Published var proxySettings: ProxySettings {
        didSet {
            let normalized = proxySettings.normalized
            if proxySettings != normalized {
                proxySettings = normalized
                return
            }
            save()
        }
    }

    @Published var downloadDirectories: [DownloadCategory: String] {
        didSet { save() }
    }

    @Published var siteLogins: [SiteLogin] {
        didSet { save() }
    }

    @Published var message = ""

    private let defaults: UserDefaults
    private let storageKey = "Firelink.AppSettings.v1"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults

        if let data = defaults.data(forKey: storageKey),
           let stored = try? JSONDecoder().decode(StoredSettings.self, from: data) {
            perServerConnections = min(max(stored.perServerConnections, 1), 16)
            maxConcurrentDownloads = min(max(stored.maxConcurrentDownloads ?? 3, 1), 12)
            globalSpeedLimitKiBPerSecond = min(max(stored.globalSpeedLimitKiBPerSecond ?? 0, 0), 10_485_760)
            preventsSleepWhileDownloading = stored.preventsSleepWhileDownloading
            proxySettings = stored.proxySettings?.normalized ?? ProxySettings()
            siteLogins = stored.siteLogins
            downloadDirectories = Self.decodeDirectories(stored.downloadDirectories)
        } else {
            perServerConnections = 16
            maxConcurrentDownloads = 3
            globalSpeedLimitKiBPerSecond = 0
            preventsSleepWhileDownloading = true
            proxySettings = ProxySettings()
            siteLogins = []
            downloadDirectories = Self.defaultDirectories()
        }

        for category in DownloadCategory.allCases where downloadDirectories[category] == nil {
            downloadDirectories[category] = Self.defaultDirectory(for: category).path
        }
    }

    func destinationDirectory(for category: DownloadCategory) -> URL {
        let path = downloadDirectories[category] ?? Self.defaultDirectory(for: category).path
        return URL(fileURLWithPath: NSString(string: path).expandingTildeInPath, isDirectory: true)
    }

    func setDirectory(_ path: String, for category: DownloadCategory) {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        downloadDirectories[category] = NSString(string: trimmed).expandingTildeInPath
    }

    func resetDirectories() {
        downloadDirectories = Self.defaultDirectories()
    }

    var downloadProxyConfiguration: DownloadProxyConfiguration {
        DownloadProxyConfiguration(
            mode: proxySettings.mode,
            customProxyURI: proxySettings.customProxyURI
        )
    }

    func addSiteLogin(urlPattern: String, username: String, password: String) {
        let pattern = urlPattern.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanUsername = username.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !pattern.isEmpty, !cleanUsername.isEmpty else {
            message = "Add a URL pattern and username."
            return
        }

        let login = SiteLogin(urlPattern: pattern, username: cleanUsername)
        guard KeychainCredentialStore.setPassword(password, for: login.id) else {
            message = "Could not save the password to Keychain."
            return
        }

        siteLogins.append(login)
        message = "Added login for \(pattern)."
    }

    func deleteSiteLogins(at offsets: IndexSet) {
        for offset in offsets {
            KeychainCredentialStore.deletePassword(for: siteLogins[offset].id)
        }
        siteLogins.remove(atOffsets: offsets)
    }

    func credentials(for url: URL) -> DownloadCredentials? {
        guard let login = siteLogins.first(where: { Self.matches(url: url, pattern: $0.urlPattern) }),
              let password = KeychainCredentialStore.password(for: login.id) else {
            return nil
        }

        return DownloadCredentials(username: login.username, password: password)
    }

    func credentials(for login: SiteLogin) -> DownloadCredentials? {
        guard let password = KeychainCredentialStore.password(for: login.id) else {
            return nil
        }

        return DownloadCredentials(username: login.username, password: password)
    }

    private func save() {
        let stored = StoredSettings(
            perServerConnections: perServerConnections,
            maxConcurrentDownloads: maxConcurrentDownloads,
            globalSpeedLimitKiBPerSecond: globalSpeedLimitKiBPerSecond,
            preventsSleepWhileDownloading: preventsSleepWhileDownloading,
            proxySettings: proxySettings.normalized,
            downloadDirectories: Dictionary(uniqueKeysWithValues: downloadDirectories.map { ($0.key.rawValue, $0.value) }),
            siteLogins: siteLogins
        )

        if let data = try? JSONEncoder().encode(stored) {
            defaults.set(data, forKey: storageKey)
        }
    }

    private static func matches(url: URL, pattern rawPattern: String) -> Bool {
        let pattern = rawPattern.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !pattern.isEmpty else { return false }

        let host = (url.host(percentEncoded: false) ?? "").lowercased()
        let absolute = url.absoluteString.lowercased()
        let normalizedPattern = URL(string: pattern)?.host ?? pattern

        if normalizedPattern.hasPrefix("*.") {
            let suffix = String(normalizedPattern.dropFirst(2))
            return host == suffix || host.hasSuffix(".\(suffix)")
        }

        if normalizedPattern.contains("*") {
            let escaped = NSRegularExpression.escapedPattern(for: normalizedPattern)
                .replacingOccurrences(of: "\\*", with: ".*")
            return host.range(of: "^\(escaped)$", options: .regularExpression) != nil
        }

        if normalizedPattern.contains("/") {
            return absolute.contains(normalizedPattern)
        }

        return host == normalizedPattern || host.hasSuffix(".\(normalizedPattern)")
    }

    private static func defaultDirectories() -> [DownloadCategory: String] {
        Dictionary(uniqueKeysWithValues: DownloadCategory.allCases.map { ($0, defaultDirectory(for: $0).path) })
    }

    private static func defaultDirectory(for category: DownloadCategory) -> URL {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Downloads")
        return downloads.appendingPathComponent(category.rawValue, isDirectory: true)
    }

    private static func decodeDirectories(_ stored: [String: String]) -> [DownloadCategory: String] {
        Dictionary(uniqueKeysWithValues: stored.compactMap { key, value in
            guard let category = DownloadCategory(rawValue: key) else { return nil }
            return (category, value)
        })
    }
}

private struct StoredSettings: Codable {
    var perServerConnections: Int
    var maxConcurrentDownloads: Int?
    var globalSpeedLimitKiBPerSecond: Int?
    var preventsSleepWhileDownloading: Bool
    var proxySettings: ProxySettings?
    var downloadDirectories: [String: String]
    var siteLogins: [SiteLogin]
}
