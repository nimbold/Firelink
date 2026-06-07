import Foundation

enum MediaDetector {
    private static let supportedDomains: Set<String> = [
        "youtube.com", "youtu.be",
        "twitter.com", "x.com",
        "vimeo.com",
        "twitch.tv",
        "instagram.com",
        "tiktok.com",
        "facebook.com", "fb.watch",
        "reddit.com", "v.redd.it",
        "soundcloud.com"
    ]

    static func isSupportedMedia(url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }

        for domain in supportedDomains {
            if host == domain || host.hasSuffix(".\(domain)") {
                // Ignore raw files that happen to be hosted on these domains, if any,
                // though usually these domains serve web pages for media.
                return true
            }
        }
        return false
    }
}
