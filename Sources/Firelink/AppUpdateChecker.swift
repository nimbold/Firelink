import Foundation

@MainActor
final class AppUpdateChecker: ObservableObject {
    enum Status: Equatable {
        case idle
        case checking
        case upToDate(String)
        case updateAvailable(latestVersion: String, releaseURL: URL)
        case unavailable(String)

        var message: String {
            switch self {
            case .idle:
                "Check GitHub Releases for the latest Firelink build."
            case .checking:
                "Checking for updates..."
            case .upToDate(let version):
                "Firelink is up to date. Latest version: \(version)."
            case .updateAvailable(let latestVersion, _):
                "Version \(latestVersion) is available."
            case .unavailable(let message):
                message
            }
        }
    }

    @Published private(set) var status: Status = .idle
    @Published private(set) var lastChecked: Date?

    let releasesURL = URL(string: "https://github.com/nimbold/Firelink/releases")!

    private let latestReleaseURL = URL(string: "https://api.github.com/repos/nimbold/Firelink/releases/latest")!
    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func checkForUpdates(currentVersion: String) async {
        status = .checking
        lastChecked = Date()

        do {
            var request = URLRequest(url: latestReleaseURL)
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            request.setValue("Firelink", forHTTPHeaderField: "User-Agent")

            let (data, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                status = .unavailable("Could not read the update server response.")
                return
            }

            guard httpResponse.statusCode == 200 else {
                status = .unavailable("No published Firelink release was found.")
                return
            }

            let release = try JSONDecoder().decode(GitHubRelease.self, from: data)
            let latestVersion = release.version
            if VersionComparator.isVersion(latestVersion, newerThan: currentVersion) {
                status = .updateAvailable(latestVersion: latestVersion, releaseURL: release.htmlURL)
            } else {
                status = .upToDate(latestVersion)
            }
        } catch {
            status = .unavailable("Could not check for updates. Try again later.")
        }
    }
}

private struct GitHubRelease: Decodable {
    let tagName: String
    let htmlURL: URL

    var version: String {
        tagName.trimmingCharacters(in: CharacterSet(charactersIn: "vV"))
    }

    enum CodingKeys: String, CodingKey {
        case tagName = "tag_name"
        case htmlURL = "html_url"
    }
}

private enum VersionComparator {
    static func isVersion(_ candidate: String, newerThan current: String) -> Bool {
        let candidateParts = parts(from: candidate)
        let currentParts = parts(from: current)
        let count = max(candidateParts.count, currentParts.count)

        for index in 0..<count {
            let candidateValue = index < candidateParts.count ? candidateParts[index] : 0
            let currentValue = index < currentParts.count ? currentParts[index] : 0
            if candidateValue != currentValue {
                return candidateValue > currentValue
            }
        }

        return false
    }

    private static func parts(from version: String) -> [Int] {
        version
            .trimmingCharacters(in: CharacterSet(charactersIn: "vV"))
            .split(separator: ".")
            .map { component in
                let digits = component.prefix(while: \.isNumber)
                return Int(digits) ?? 0
            }
    }
}
