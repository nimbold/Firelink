import AppKit
import SwiftUI

struct DownloadPropertiesWindow: View {
    @EnvironmentObject private var controller: DownloadController
    let downloadID: UUID

    var body: some View {
        if let item = controller.downloads.first(where: { $0.id == downloadID }) {
            DownloadPropertiesView(item: item)
        } else {
            ContentUnavailableView("Download Not Found", systemImage: "questionmark.circle")
                .frame(width: 420, height: 240)
        }
    }
}

struct DownloadPropertiesView: View {
    enum LoginMode: String, CaseIterable, Identifiable {
        case matching = "Matching site login"
        case custom = "Custom credentials"
        case none = "No login"

        var id: String { rawValue }
    }

    @EnvironmentObject private var controller: DownloadController
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.dismiss) private var dismiss

    let item: DownloadItem

    @State private var urlText: String
    @State private var fileName: String
    @State private var destinationPath: String
    @State private var connections: Int
    @State private var loginMode: LoginMode
    @State private var username: String
    @State private var password: String
    @State private var speedLimitEnabled: Bool
    @State private var speedLimitKiBPerSecond: Int
    @State private var checksumEnabled: Bool
    @State private var checksumAlgorithm: ChecksumAlgorithm
    @State private var checksumValue: String
    @State private var headerText: String
    @State private var cookieText: String
    @State private var mirrorText: String
    @State private var errorMessage = ""
    @State private var showsAdvancedTransfer = false
    @State private var showsChunkMap = false

    init(item: DownloadItem) {
        self.item = item
        _urlText = State(initialValue: item.url.absoluteString)
        _fileName = State(initialValue: item.fileName)
        _destinationPath = State(initialValue: item.destinationDirectory.path)
        _connections = State(initialValue: item.connectionsPerServer)
        _speedLimitEnabled = State(initialValue: (item.speedLimitKiBPerSecond ?? 0) > 0)
        _speedLimitKiBPerSecond = State(initialValue: max(item.speedLimitKiBPerSecond ?? 1024, 1))
        if let credentials = item.credentials {
            _loginMode = State(initialValue: .custom)
            _username = State(initialValue: credentials.username)
            _password = State(initialValue: credentials.password)
        } else {
            _loginMode = State(initialValue: .matching)
            _username = State(initialValue: "")
            _password = State(initialValue: "")
        }
        if let checksum = item.checksum {
            _checksumEnabled = State(initialValue: true)
            _checksumAlgorithm = State(initialValue: checksum.algorithm)
            _checksumValue = State(initialValue: checksum.value)
        } else {
            _checksumEnabled = State(initialValue: false)
            _checksumAlgorithm = State(initialValue: .sha256)
            _checksumValue = State(initialValue: "")
        }
        _headerText = State(initialValue: (item.requestHeaders ?? []).map(\.headerLine).joined(separator: "\n"))
        _cookieText = State(initialValue: item.cookieHeader ?? "")
        _mirrorText = State(initialValue: (item.mirrorURLs ?? []).map(\.absoluteString).joined(separator: "\n"))
    }

    var body: some View {
        VStack(spacing: 0) {
            DownloadSummaryHeader(item: item)
                .padding(.horizontal, 18)
                .padding(.vertical, 12)

            Divider()

            Form {
                if let noticeText {
                    Section {
                        Label(noticeText, systemImage: noticeSystemImage)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Download") {
                    Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
                        GridRow {
                            Text("URL")
                                .foregroundStyle(.secondary)
                            TextField("URL", text: $urlText)
                                .font(.system(.callout, design: .monospaced))
                                .disabled(fileIdentityLocked)
                        }

                        GridRow {
                            Text("File name")
                                .foregroundStyle(.secondary)
                            TextField("File name", text: $fileName)
                                .disabled(fileIdentityLocked)
                        }

                        GridRow {
                            Text("Save location")
                                .foregroundStyle(.secondary)
                            HStack(spacing: 8) {
                                TextField("Save location", text: $destinationPath)
                                    .font(.system(.callout, design: .monospaced))
                                    .disabled(fileIdentityLocked)
                                Button {
                                    selectDestination()
                                } label: {
                                    Label("Select", systemImage: "folder.badge.plus")
                                }
                                .disabled(fileIdentityLocked)
                            }
                        }

                        GridRow {
                            Text("Connections")
                                .foregroundStyle(.secondary)
                            Stepper("\(connections) per file", value: $connections, in: 1...16)
                                .disabled(transferSettingsLocked)
                        }

                        GridRow {
                            Text("Speed")
                                .foregroundStyle(.secondary)
                            HStack {
                                Toggle("Limit", isOn: $speedLimitEnabled)
                                if speedLimitEnabled {
                                    Stepper(
                                        "\(speedLimitKiBPerSecond) KiB/s",
                                        value: $speedLimitKiBPerSecond,
                                        in: 1...10_485_760,
                                        step: 128
                                    )
                                }
                            }
                        }
                    }
                }

                Section(item.status == .completed ? "Site Login for Redownload" : "Site Login") {
                    Picker("Login", selection: $loginMode) {
                        ForEach(LoginMode.allCases) { mode in
                            Text(mode.rawValue).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                    .disabled(transferSettingsLocked)

                    if loginMode == .matching {
                        Text(matchingLoginText)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if loginMode == .custom {
                        TextField("Username", text: $username)
                            .disabled(transferSettingsLocked)
                        SecureField("Password", text: $password)
                            .disabled(transferSettingsLocked)
                    }
                }

                Section {
                    CollapsibleGroup(title: advancedTransferTitle, isExpanded: $showsAdvancedTransfer) {
                        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 8) {
                            GridRow {
                                Text("Checksum")
                                    .foregroundStyle(.secondary)
                                Toggle("Verify", isOn: $checksumEnabled)
                                .disabled(transferSettingsLocked)
                            }

                            if checksumEnabled {
                                GridRow {
                                    Text("Algorithm")
                                        .foregroundStyle(.secondary)
                                    Picker("Algorithm", selection: $checksumAlgorithm) {
                                        ForEach(ChecksumAlgorithm.allCases) { algorithm in
                                            Text(algorithm.title).tag(algorithm)
                                        }
                                    }
                                    .disabled(transferSettingsLocked)
                                }

                                GridRow {
                                    Text("Digest")
                                        .foregroundStyle(.secondary)
                                    TextField("Expected digest", text: $checksumValue)
                                        .font(.system(.callout, design: .monospaced))
                                        .disabled(transferSettingsLocked)
                                }
                            }

                            GridRow {
                                Text("Cookies")
                                    .foregroundStyle(.secondary)
                                TextField("Cookies", text: $cookieText)
                                    .font(.system(.callout, design: .monospaced))
                                    .disabled(transferSettingsLocked)
                            }
                        }

                        CompactEditor(title: "Headers", text: $headerText)
                            .disabled(transferSettingsLocked)
                        CompactEditor(title: "Mirrors", text: $mirrorText)
                            .disabled(transferSettingsLocked)
                    }
                }

                if item.status == .downloading && item.rpcPort != nil {
                    Section {
                        CollapsibleGroup(title: "Chunk Map", isExpanded: $showsChunkMap) {
                            ChunkMapView(item: item)
                        }
                    }
                }
            }
            .formStyle(.grouped)

            Divider()
            HStack {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(1)
                Spacer()
                Button("Cancel") {
                    dismiss()
                }
                Button {
                    save()
                } label: {
                    Label("Save", systemImage: "checkmark")
                }
                .buttonStyle(.borderedProminent)
            }
            .padding(12)
            .background(.bar)
        }
        .frame(width: 720, height: 580)
    }

    private var fileIdentityLocked: Bool {
        item.status == .completed || item.status == .downloading
    }

    private var transferSettingsLocked: Bool {
        item.status == .downloading
    }

    private var noticeText: String? {
        switch item.status {
        case .completed:
            return "File identity is read-only. Transfer settings are saved for redownload."
        case .downloading:
            return "Only the speed limit applies to the current transfer. Other settings can be changed after stopping or pausing."
        default:
            return nil
        }
    }

    private var noticeSystemImage: String {
        item.status == .completed ? "checkmark.circle" : "bolt.horizontal.circle"
    }

    private var advancedTransferTitle: String {
        item.status == .completed ? "Advanced Transfer for Redownload" : "Advanced Transfer"
    }

    private struct CompactEditor: View {
        let title: String
        @Binding var text: String

        var body: some View {
            VStack(alignment: .leading, spacing: 5) {
                Text(title)
                    .foregroundStyle(.secondary)
                TextEditor(text: $text)
                    .font(.system(.callout, design: .monospaced))
                    .frame(minHeight: 44, maxHeight: 54)
            }
        }
    }

    private struct CollapsibleGroup<Content: View>: View {
        let title: String
        @Binding var isExpanded: Bool
        @ViewBuilder var content: () -> Content

        var body: some View {
            VStack(alignment: .leading, spacing: isExpanded ? 10 : 0) {
                Button {
                    isExpanded.toggle()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(width: 12)
                        Text(title)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if isExpanded {
                    content()
                        .padding(.leading, 18)
                }
            }
        }
    }

    private var matchingLoginText: String {
        guard let url = URL(string: urlText),
              let credentials = settings.credentials(for: url) else {
            return "No matching saved login for this URL."
        }

        return "Will use saved login for \(credentials.username)."
    }

    private func selectDestination() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.directoryURL = URL(fileURLWithPath: NSString(string: destinationPath).expandingTildeInPath)

        if panel.runModal() == .OK, let url = panel.url {
            destinationPath = url.path
        }
    }

    private func save() {
        guard let url = URL(string: urlText.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(),
              ["http", "https", "ftp", "sftp"].contains(scheme) else {
            errorMessage = "Enter a valid HTTP, HTTPS, FTP, or SFTP URL."
            return
        }

        let cleanFileName = FileClassifier.sanitizedFileName(fileName)
        guard !cleanFileName.isEmpty else {
            errorMessage = "File name cannot be empty."
            return
        }

        let destination = URL(
            fileURLWithPath: NSString(string: destinationPath.trimmingCharacters(in: .whitespacesAndNewlines)).expandingTildeInPath,
            isDirectory: true
        )

        let credentials: DownloadCredentials?
        switch loginMode {
        case .matching:
            credentials = settings.credentials(for: url)
        case .custom:
            let custom = DownloadCredentials(username: username, password: password)
            credentials = custom.isEmpty ? nil : custom
        case .none:
            credentials = nil
        }

        guard let transferOptions = validatedTransferOptions else {
            return
        }

        controller.updateDownload(
            id: item.id,
            url: url,
            fileName: cleanFileName,
            destinationDirectory: destination,
            connectionsPerServer: connections,
            credentials: credentials,
            transferOptions: transferOptions,
            speedLimitKiBPerSecond: speedLimitEnabled ? speedLimitKiBPerSecond : nil
        )
        dismiss()
    }

    private var validatedTransferOptions: DownloadTransferOptions? {
        if checksumEnabled && checksumValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            errorMessage = "Add the expected checksum digest, or turn checksum off."
            return nil
        }

        if DownloadTransferOptionParser.invalidHeaderLines(headerText).isEmpty == false {
            errorMessage = "Headers must use Name: Value lines."
            return nil
        }

        if DownloadTransferOptionParser.invalidMirrorLines(mirrorText).isEmpty == false {
            errorMessage = "Mirrors must be valid HTTP, HTTPS, FTP, or SFTP URLs."
            return nil
        }

        return DownloadTransferOptions(
            checksum: checksumEnabled ? DownloadChecksum(algorithm: checksumAlgorithm, value: checksumValue).normalized : nil,
            requestHeaders: DownloadTransferOptionParser.parseHeaders(headerText),
            cookieHeader: DownloadTransferOptionParser.cleanCookieHeader(cookieText),
            mirrorURLs: DownloadTransferOptionParser.parseMirrorURLs(mirrorText)
        )
    }
}

private struct DownloadSummaryHeader: View {
    let item: DownloadItem

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(item.fileName)
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                Label(item.status.rawValue, systemImage: item.category.symbolName)
                    .foregroundStyle(statusColor)
            }

            ProgressView(value: item.status == .completed ? 1.0 : item.progress)

            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 5) {
                GridRow {
                    summary("Progress", (item.status == .completed ? 1.0 : item.progress).formatted(.percent.precision(.fractionLength(0))))
                    summary("Size", ByteFormatter.string(item.sizeBytes))
                    summary("Speed", item.displaySpeedText)
                    summary("ETA", item.displayETAText)
                }
                GridRow {
                    summary("Live connections", "\(item.connectionCount)")
                    summary("Speed cap", item.speedLimitText)
                    summary("Category", item.category.rawValue)
                    summary("Last try", item.lastTryAt?.formatted(date: .abbreviated, time: .shortened) ?? "-")
                }
                GridRow {
                    summary("Date added", item.createdAt.formatted(date: .abbreviated, time: .shortened))
                        .gridCellColumns(2)
                    summary("Destination", item.destinationPath)
                        .gridCellColumns(2)
                }
            }
            .font(.caption)
        }
    }

    private var statusColor: Color {
        switch item.status {
        case .queued:
            .secondary
        case .downloading:
            .accentColor
        case .paused:
            .orange
        case .completed:
            .green
        case .failed, .canceled:
            .red
        }
    }

    private func summary(_ label: String, _ value: String) -> some View {
        HStack(spacing: 4) {
            Text(label)
                .foregroundStyle(.secondary)
            Text(value)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}
