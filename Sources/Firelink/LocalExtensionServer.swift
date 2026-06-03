import Foundation
import Network
import AppKit

final class LocalExtensionServer: @unchecked Sendable {
    private enum Constants {
        static let port = NWEndpoint.Port(rawValue: 6412)!
        static let maxRequestBytes = 128 * 1024
        static let maxURLCount = 200
        static let allowedSchemes = Set(["http", "https", "ftp", "sftp"])
    }

    private let listener: NWListener
    private let downloadController: DownloadController
    private let queue = DispatchQueue(label: "local.firelink.server")

    init?(downloadController: DownloadController) {
        self.downloadController = downloadController
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: Constants.port)
        
        do {
            listener = try NWListener(using: parameters)
        } catch {
            print("Failed to create listener: \(error)")
            return nil
        }
    }

    func start() {
        listener.newConnectionHandler = { [weak self] connection in
            self?.handleConnection(connection)
        }
        listener.stateUpdateHandler = { state in
            print("LocalExtensionServer state: \(state)")
        }
        listener.start(queue: queue)
    }

    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: queue)
        receiveRequest(from: connection, accumulatedData: Data())
    }

    private func receiveRequest(from connection: NWConnection, accumulatedData: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else {
                connection.cancel()
                return
            }

            var requestData = accumulatedData
            if let data {
                requestData.append(data)
            }

            guard error == nil, requestData.count <= Constants.maxRequestBytes else {
                self.sendResponse(.payloadTooLarge, connection: connection, origin: nil)
                return
            }

            if let request = HTTPRequest(data: requestData) {
                let status = self.processRequest(request)
                self.sendResponse(status, connection: connection, origin: request.header(named: "origin"))
                return
            }

            if isComplete {
                self.sendResponse(.badRequest, connection: connection, origin: nil)
                return
            }

            self.receiveRequest(from: connection, accumulatedData: requestData)
        }
    }

    private func sendResponse(_ status: HTTPStatus, connection: NWConnection, origin: String?) {
        var headers = [
            "HTTP/1.1 \(status.rawValue) \(status.reason)",
            "Content-Length: 0",
            "Connection: close"
        ]

        if let origin, isAllowedExtensionOrigin(origin) {
            headers.append("Access-Control-Allow-Origin: \(origin)")
            headers.append("Vary: Origin")
            headers.append("Access-Control-Allow-Methods: POST, OPTIONS")
            headers.append("Access-Control-Allow-Headers: Content-Type")
        }

        let response = headers.joined(separator: "\r\n") + "\r\n\r\n"
        connection.send(content: response.data(using: .utf8), completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func isAllowedExtensionOrigin(_ origin: String) -> Bool {
        guard let url = URL(string: origin),
              let scheme = url.scheme?.lowercased() else {
            return false
        }

        return scheme == "moz-extension" || scheme == "chrome-extension"
    }

    private func processRequest(_ request: HTTPRequest) -> HTTPStatus {
        guard request.path == "/download" else {
            return .notFound
        }

        if request.method == "OPTIONS" {
            return isAllowedExtensionOrigin(request.header(named: "origin") ?? "") ? .noContent : .forbidden
        }

        guard request.method == "POST" else {
            return .methodNotAllowed
        }

        guard request.header(named: "content-type")?.lowercased().contains("application/json") == true else {
            return .unsupportedMediaType
        }

        struct Payload: Decodable {
            let urls: [String]
            let referer: String?
        }

        do {
            let payload = try JSONDecoder().decode(Payload.self, from: request.body)
            let validURLs = payload.urls
                .prefix(Constants.maxURLCount)
                .compactMap { rawURL -> String? in
                    let trimmed = rawURL.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard let url = URL(string: trimmed),
                          let scheme = url.scheme?.lowercased(),
                          Constants.allowedSchemes.contains(scheme) else {
                        return nil
                    }
                    return url.absoluteString
                }

            guard !validURLs.isEmpty else {
                return .badRequest
            }

            Task { @MainActor in
                self.downloadController.pendingPasteboardText = validURLs.joined(separator: "\n")
                NotificationCenter.default.post(name: NSNotification.Name("OpenAddDownloadsWindow"), object: nil)
                NSApp.activate(ignoringOtherApps: true)
            }

            return .ok
        } catch {
            print("Failed to parse local request JSON: \(error)")
            return .badRequest
        }
    }
}

private struct HTTPRequest {
    var method: String
    var path: String
    var headers: [String: String]
    var body: Data

    init?(data: Data) {
        guard let headerRange = data.range(of: Data("\r\n\r\n".utf8)) else {
            return nil
        }

        let headerData = data[..<headerRange.lowerBound]
        guard let headerString = String(data: headerData, encoding: .utf8) else {
            return nil
        }

        let lines = headerString.split(separator: "\r\n", omittingEmptySubsequences: false)
        guard let requestLine = lines.first else {
            return nil
        }

        let requestParts = requestLine.split(separator: " ", maxSplits: 2)
        guard requestParts.count >= 2 else {
            return nil
        }

        var parsedHeaders: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colonIndex = line.firstIndex(of: ":") else {
                continue
            }
            let name = line[..<colonIndex].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let value = line[line.index(after: colonIndex)...].trimmingCharacters(in: .whitespacesAndNewlines)
            parsedHeaders[name] = value
        }

        let bodyStart = headerRange.upperBound
        let expectedBodyLength = parsedHeaders["content-length"].flatMap(Int.init) ?? 0
        guard expectedBodyLength >= 0,
              data.count >= bodyStart + expectedBodyLength else {
            return nil
        }

        method = String(requestParts[0]).uppercased()
        path = String(requestParts[1]).split(separator: "?", maxSplits: 1).first.map(String.init) ?? ""
        headers = parsedHeaders
        body = data[bodyStart..<(bodyStart + expectedBodyLength)]
    }

    func header(named name: String) -> String? {
        headers[name.lowercased()]
    }
}

private enum HTTPStatus: Int {
    case ok = 200
    case noContent = 204
    case badRequest = 400
    case forbidden = 403
    case notFound = 404
    case methodNotAllowed = 405
    case payloadTooLarge = 413
    case unsupportedMediaType = 415

    var reason: String {
        switch self {
        case .ok: "OK"
        case .noContent: "No Content"
        case .badRequest: "Bad Request"
        case .forbidden: "Forbidden"
        case .notFound: "Not Found"
        case .methodNotAllowed: "Method Not Allowed"
        case .payloadTooLarge: "Payload Too Large"
        case .unsupportedMediaType: "Unsupported Media Type"
        }
    }
}
