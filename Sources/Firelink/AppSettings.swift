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

enum BrowserCookieSource: String, Codable, CaseIterable, Sendable {
    case none = "None"
    case safari = "Safari"
    case chrome = "Chrome"
    case firefox = "Firefox"
    case edge = "Edge"
    case brave = "Brave"

    var ytDlpBrowserName: String? {
        switch self {
        case .none:
            nil
        case .safari, .chrome, .firefox, .edge, .brave:
            rawValue.lowercased()
        }
    }

    var statusTitle: String {
        switch self {
        case .none:
            "Not using browser cookies"
        case .safari, .chrome, .firefox, .edge, .brave:
            "Using \(rawValue) cookies"
        }
    }

    var statusDetail: String {
        switch self {
        case .none:
            "Restricted media may fail if the site requires login."
        case .safari:
            "yt-dlp reads Safari cookies during metadata fetch and download. Safari may require Full Disk Access."
        case .chrome, .firefox, .edge, .brave:
            "yt-dlp reads these browser cookies during metadata fetch and download. Firelink does not store them."
        }
    }
}

enum ProxyType: String, Codable, CaseIterable, Sendable {
    case http
    case https
    case ftp
    case socks5

    var title: String {
        switch self {
        case .http: "HTTP"
        case .https: "HTTPS (legacy)"
        case .ftp: "FTP (legacy)"
        case .socks5: "SOCKS5"
        }
    }

    var uriScheme: String {
        switch self {
        case .http, .https, .ftp:
            "http"
        case .socks5:
            "socks5"
        }
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
        if copy.type != .http {
            copy.type = .http
        }
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
    @Published var appTheme: AppTheme = .system {
        didSet { save() }
    }

    @Published var appFontSize: AppFontSize = .standard {
        didSet { save() }
    }

    @Published var listRowDensity: ListRowDensity = .standard {
        didSet { save() }
    }

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

    @Published var showNotifications: Bool {
        didSet { save() }
    }

    @Published var customUserAgent: String {
        didSet { save() }
    }

    @Published var playCompletionSound: Bool {
        didSet { save() }
    }

    @Published var showDockBadge: Bool {
        didSet { save() }
    }

    @Published var maxAutomaticRetries: Int {
        didSet {
            let clamped = min(max(maxAutomaticRetries, 0), 10)
            if maxAutomaticRetries != clamped {
                maxAutomaticRetries = clamped
                return
            }
            save()
        }
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

    @Published var mediaCookieSource: BrowserCookieSource {
        didSet { save() }
    }

    @Published var extensionPairingToken: String {
        didSet {
            if isKeychainAccessGranted {
                KeychainCredentialStore.setExtensionToken(extensionPairingToken)
            }
        }
    }

    @Published var isKeychainAccessGranted: Bool {
        didSet { save() }
    }

    @Published var showKeychainPrimer = false

    @Published var askWhereToSaveEachFile: Bool {
        didSet { save() }
    }

    @Published var message = ""

    private let defaults: UserDefaults
    private let storageKey = "Firelink.AppSettings.v1"
    private var saveTask: Task<Void, Never>?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults

        let granted: Bool
        if let data = defaults.data(forKey: storageKey),
           let stored = try? JSONDecoder().decode(StoredSettings.self, from: data) {
            appTheme = stored.appTheme ?? .system
            appFontSize = stored.appFontSize ?? .standard
            listRowDensity = stored.listRowDensity ?? .standard
            perServerConnections = min(max(stored.perServerConnections, 1), 16)
            maxConcurrentDownloads = min(max(stored.maxConcurrentDownloads ?? 3, 1), 12)
            globalSpeedLimitKiBPerSecond = min(max(stored.globalSpeedLimitKiBPerSecond ?? 0, 0), 10_485_760)
            preventsSleepWhileDownloading = stored.preventsSleepWhileDownloading
            showNotifications = stored.showNotifications ?? true
            playCompletionSound = stored.playCompletionSound ?? true
            showDockBadge = stored.showDockBadge ?? true
            customUserAgent = stored.customUserAgent ?? ""
            maxAutomaticRetries = min(max(stored.maxAutomaticRetries ?? 3, 0), 10)
            proxySettings = stored.proxySettings?.normalized ?? ProxySettings()
            siteLogins = stored.siteLogins
            mediaCookieSource = stored.mediaCookieSource ?? .none
            downloadDirectories = Self.decodeDirectories(stored.downloadDirectories)
            granted = stored.isKeychainAccessGranted ?? false
            isKeychainAccessGranted = granted
            askWhereToSaveEachFile = stored.askWhereToSaveEachFile ?? false
        } else {
            appTheme = .system
            appFontSize = .standard
            listRowDensity = .standard
            perServerConnections = 16
            maxConcurrentDownloads = 3
            globalSpeedLimitKiBPerSecond = 0
            preventsSleepWhileDownloading = true
            showNotifications = true
            playCompletionSound = true
            showDockBadge = true
            customUserAgent = ""
            maxAutomaticRetries = 3
            proxySettings = ProxySettings()
            siteLogins = []
            mediaCookieSource = .none
            downloadDirectories = Self.defaultDirectories()
            granted = false
            isKeychainAccessGranted = granted
            askWhereToSaveEachFile = false
        }

        let currentVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
        let currentBuild = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown"
        var execHash = "unknown"
        if let execPath = Bundle.main.executablePath,
           let attr = try? FileManager.default.attributesOfItem(atPath: execPath),
           let modDate = attr[.modificationDate] as? Date {
            execHash = String(modDate.timeIntervalSince1970)
        }
        let fullVersion = "\(currentVersion).\(currentBuild).\(execHash)"
        let lastVersion = defaults.string(forKey: "Firelink.lastLaunchedVersion")
        defaults.set(fullVersion, forKey: "Firelink.lastLaunchedVersion")

        var needsPrimer = false
        if granted {
            if let lastVersion, lastVersion != fullVersion {
                needsPrimer = true
            }
        }

        if granted {
            if needsPrimer {
                showKeychainPrimer = true
                extensionPairingToken = ""
            } else {
                if let token = KeychainCredentialStore.extensionToken() {
                    extensionPairingToken = token
                } else {
                    extensionPairingToken = Self.generateSecureToken()
                    // The didSet of extensionPairingToken will handle setting it in the keychain since isKeychainAccessGranted is true.
                }
            }
        } else {
            extensionPairingToken = ""
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
        saveSiteLogin(id: nil, urlPattern: urlPattern, username: username, password: password)
    }

    func saveSiteLogin(id: UUID?, urlPattern: String, username: String, password: String) {
        let pattern = urlPattern.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanUsername = username.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !pattern.isEmpty, !cleanUsername.isEmpty else {
            message = "Add a URL pattern and username."
            return
        }

        if let id,
           siteLogins.contains(where: { $0.id != id && $0.urlPattern.caseInsensitiveCompare(pattern) == .orderedSame }) {
            message = "A login for \(pattern) already exists."
            return
        }

        if let index = siteLogins.firstIndex(where: { login in
            if let id {
                return login.id == id
            }
            return login.urlPattern.caseInsensitiveCompare(pattern) == .orderedSame
        }) {
            let loginID = siteLogins[index].id
            if !password.isEmpty, !KeychainCredentialStore.setPassword(password, for: loginID) {
                message = "Could not save the password to Keychain."
                return
            }
            siteLogins[index].urlPattern = pattern
            siteLogins[index].username = cleanUsername
            message = "Updated login for \(pattern)."
            return
        }

        guard !password.isEmpty else {
            message = "Add a password."
            return
        }

        let login = SiteLogin(urlPattern: pattern, username: cleanUsername)
        if !KeychainCredentialStore.setPassword(password, for: login.id) {
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

    func grantKeychainAccess() {
        isKeychainAccessGranted = true
        if let token = KeychainCredentialStore.extensionToken() {
            extensionPairingToken = token
        } else {
            extensionPairingToken = Self.generateSecureToken()
        }
    }

    func revokeKeychainAccess() {
        KeychainCredentialStore.deleteExtensionToken()
        for login in siteLogins {
            KeychainCredentialStore.deletePassword(for: login.id)
        }
        siteLogins.removeAll()
        extensionPairingToken = ""
        isKeychainAccessGranted = false
    }

    func resolveKeychainPrimer(grantAccess: Bool) {
        showKeychainPrimer = false
        if grantAccess {
            if let token = KeychainCredentialStore.extensionToken() {
                extensionPairingToken = token
            } else {
                extensionPairingToken = Self.generateSecureToken()
            }
        } else {
            revokeKeychainAccess()
        }
    }

    private func save() {
        let stored = StoredSettings(
            appTheme: appTheme,
            appFontSize: appFontSize,
            listRowDensity: listRowDensity,
            perServerConnections: perServerConnections,
            maxConcurrentDownloads: maxConcurrentDownloads,
            globalSpeedLimitKiBPerSecond: globalSpeedLimitKiBPerSecond,
            preventsSleepWhileDownloading: preventsSleepWhileDownloading,
            showNotifications: showNotifications,
            playCompletionSound: playCompletionSound,
            showDockBadge: showDockBadge,
            customUserAgent: customUserAgent,
            maxAutomaticRetries: maxAutomaticRetries,
            proxySettings: proxySettings.normalized,
            downloadDirectories: Dictionary(uniqueKeysWithValues: downloadDirectories.map { ($0.key.rawValue, $0.value) }),
            siteLogins: siteLogins,
            mediaCookieSource: mediaCookieSource,
            isKeychainAccessGranted: isKeychainAccessGranted,
            askWhereToSaveEachFile: askWhereToSaveEachFile
        )
        let defaults = self.defaults
        let storageKey = self.storageKey

        saveTask?.cancel()
        saveTask = Task { @MainActor [defaults, storageKey] in
            let data = await Task.detached(priority: .background) {
                try? JSONEncoder().encode(stored)
            }.value

            guard !Task.isCancelled, let encoded = data else { return }
            defaults.set(encoded, forKey: storageKey)
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

        return host == normalizedPattern
    }

    private static func generateSecureToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            return UUID().uuidString
        }
        return Data(bytes).base64EncodedString()
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
    var appTheme: AppTheme?
    var appFontSize: AppFontSize?
    var listRowDensity: ListRowDensity?
    var perServerConnections: Int
    var maxConcurrentDownloads: Int?
    var globalSpeedLimitKiBPerSecond: Int?
    var preventsSleepWhileDownloading: Bool
    var showNotifications: Bool?
    var playCompletionSound: Bool?
    var showDockBadge: Bool?
    var customUserAgent: String?
    var maxAutomaticRetries: Int?
    var proxySettings: ProxySettings?
    var downloadDirectories: [String: String]
    var siteLogins: [SiteLogin]
    var mediaCookieSource: BrowserCookieSource?
    var isKeychainAccessGranted: Bool?
    var askWhereToSaveEachFile: Bool?
}
