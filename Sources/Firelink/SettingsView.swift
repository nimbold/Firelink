import AppKit
import SwiftUI

struct SettingsPaneContainer: View {
    @AppStorage("lastSettingsTab") private var activeTab: SettingsSidebarFilter = .downloads

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(SettingsSidebarFilter.allCases, id: \.self) { filter in
                        Button {
                            activeTab = filter
                        } label: {
                            Text(filter.rawValue)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                        }
                        .buttonStyle(.plain)
                        .background(activeTab == filter ? Color.accentColor : Color.clear)
                        .foregroundStyle(activeTab == filter ? Color.white : Color.primary)
                        .clipShape(Capsule())
                    }
                }
                .padding(.horizontal, 32)
                .padding(.vertical, 16)
            }
            
            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text(activeTab.rawValue)
                        .font(.largeTitle.weight(.semibold))
                        .padding(.bottom, 24)

                    selectedPane
                        .frame(maxWidth: 720, alignment: .leading)
                }
                .padding(32)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var selectedPane: some View {
        switch activeTab {
        case .downloads:
            DownloadSettingsPane()
        case .lookAndFeel:
            LookAndFeelSettingsPane()
        case .network:
            NetworkSettingsPane()
        case .locations:
            LocationsSettingsPane()
        case .siteLogins:
            SiteLoginsSettingsPane()
        case .power:
            PowerSettingsPane()
        case .engine:
            EngineSettingsPane()
        case .integration:
            IntegrationSettingsPane()
        case .about:
            AboutSettingsPane()
        }
    }
}

private struct LookAndFeelSettingsPane: View {
    @EnvironmentObject private var settings: AppSettings
    @AppStorage("showMenuBarIcon") private var showMenuBarIcon = true

    var body: some View {
        Form {
            Section("App Theme") {
                Picker("Theme", selection: $settings.appTheme) {
                    ForEach(AppTheme.allCases) { theme in
                        Text(theme.rawValue)
                            .tag(theme)
                    }
                }
                .pickerStyle(.radioGroup)
                
                Text("Select a color palette for the app's user interface.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            
            Section("Display") {
                Picker("Font Size", selection: $settings.appFontSize) {
                    ForEach(AppFontSize.allCases) { size in
                        Text(size.rawValue).tag(size)
                    }
                }
                
                Picker("List Row Density", selection: $settings.listRowDensity) {
                    ForEach(ListRowDensity.allCases) { density in
                        Text(density.rawValue).tag(density)
                    }
                }
            }
            
            Section("Menu Bar") {
                Toggle("Show menu bar icon", isOn: $showMenuBarIcon)
                
                Text("Provides quick access to downloads and queues from the macOS menu bar. Restart required if hiding.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

private struct AboutSettingsPane: View {
    @StateObject private var updateChecker = AppUpdateChecker()
    @State private var availableUpdate: AvailableUpdate?

    private let developerProfileURL = URL(string: "https://github.com/nimbold")!
    private let projectURL = URL(string: "https://github.com/nimbold/Firelink")!
    private let aria2URL = URL(string: "https://aria2.github.io/")!
    private let licenseURL = URL(string: "https://github.com/nimbold/Firelink/blob/main/LICENSE")!

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0"
    }

    private var buildNumber: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "Development"
    }

    var body: some View {
        Form {
            Section {
                HStack(alignment: .center, spacing: 14) {
                    Image(nsImage: NSApp.applicationIconImage)
                        .resizable()
                        .frame(width: 56, height: 56)
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Firelink")
                            .font(.title2.weight(.semibold))
                        Text("Version \(appVersion)")
                            .foregroundStyle(.secondary)
                        Text("A native macOS download manager for fast, organized, segmented transfers.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }

            Section("Updates") {
                LabeledContent("Status") {
                    Label(updateChecker.status.message, systemImage: updateStatusSymbol)
                        .foregroundStyle(updateStatusColor)
                }

                if let lastChecked = updateChecker.lastChecked {
                    LabeledContent("Last checked") {
                        Text(lastChecked, format: .dateTime.month().day().hour().minute())
                            .foregroundStyle(.secondary)
                    }
                }

                HStack {
                    Button {
                        Task {
                            await updateChecker.checkForUpdates(currentVersion: appVersion)
                        }
                    } label: {
                        Label("Check for Updates", systemImage: "arrow.clockwise")
                    }
                    .disabled(updateChecker.status == .checking)

                    Button {
                        openReleasesPage()
                    } label: {
                        Label("Open Releases", systemImage: "arrow.up.right.square")
                    }

                    Spacer()
                }

                if case .updateAvailable(_, let releaseURL) = updateChecker.status {
                    Button {
                        NSWorkspace.shared.open(releaseURL)
                    } label: {
                        Label("Download Latest Version", systemImage: "square.and.arrow.down")
                    }
                    .buttonStyle(.borderedProminent)
                }
            }

            Section("Developer") {
                LabeledContent("Created by") {
                    Text("NimBold")
                }

                LabeledContent("Source") {
                    Link("nimbold/Firelink", destination: projectURL)
                }
            }

            Section("Credits") {
                LabeledContent("Download engine") {
                    Link("aria2", destination: aria2URL)
                }

                Text("Firelink uses aria2c for segmented HTTP, HTTPS, FTP, and SFTP downloads.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Legal") {
                LabeledContent("License") {
                    Link("MIT License", destination: licenseURL)
                }

                Text("Copyright © 2026 NimBold. Firelink is released under the MIT License.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onChange(of: updateChecker.status) { _, status in
            if case .updateAvailable(let latestVersion, let releaseURL) = status {
                availableUpdate = AvailableUpdate(version: latestVersion, url: releaseURL)
            }
        }
        .alert("Update Available", isPresented: Binding(
            get: { availableUpdate != nil },
            set: { isPresented in
                if !isPresented {
                    availableUpdate = nil
                }
            }
        )) {
            Button("Not Now", role: .cancel) {
                availableUpdate = nil
            }
            Button("Yes") {
                if let releaseURL = availableUpdate?.url {
                    NSWorkspace.shared.open(releaseURL)
                }
                availableUpdate = nil
            }
        } message: {
            Text("Firelink version \(availableUpdate?.version ?? "") is available. Do you want to open the download page?")
        }
    }

    private var updateStatusSymbol: String {
        switch updateChecker.status {
        case .idle:
            "sparkle.magnifyingglass"
        case .checking:
            "arrow.clockwise"
        case .upToDate:
            "checkmark.seal.fill"
        case .updateAvailable:
            "arrow.down.circle.fill"
        case .unavailable:
            "exclamationmark.triangle.fill"
        }
    }

    private var updateStatusColor: Color {
        switch updateChecker.status {
        case .idle, .checking:
            .secondary
        case .upToDate:
            .green
        case .updateAvailable:
            .accentColor
        case .unavailable:
            .orange
        }
    }

    private func openReleasesPage() {
        NSWorkspace.shared.open(updateChecker.releasesURL)
    }

    private struct AvailableUpdate: Equatable {
        var version: String
        var url: URL
    }
}

private struct EngineSettingsPane: View {
    private var executableURL: URL? {
        Aria2DownloadEngine.findExecutable()
    }

    private var version: String {
        Aria2DownloadEngine.versionString() ?? "Unavailable"
    }

    var body: some View {
        Form {
            Section {
                LabeledContent("Status") {
                    Label(
                        executableURL == nil ? "Missing" : "Ready",
                        systemImage: executableURL == nil ? "exclamationmark.triangle.fill" : "checkmark.seal.fill"
                    )
                    .foregroundStyle(executableURL == nil ? .orange : .green)
                }

                LabeledContent("Binary") {
                    Text(executableURL?.path ?? "Not found")
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                }

                LabeledContent("Version") {
                    Text(version)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                }

                if executableURL == nil {
                    Text("Install aria2 with Homebrew or bundle aria2c inside the app resources.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
    }
}

private struct NetworkSettingsPane: View {
    @EnvironmentObject private var settings: AppSettings

    var body: some View {
        Form {
            Section {
                Picker("Proxy", selection: proxyBinding(\.mode)) {
                    ForEach(ProxyMode.allCases, id: \.self) { mode in
                        Text(mode.title)
                            .tag(mode)
                    }
                }
                .pickerStyle(.radioGroup)

                if settings.proxySettings.mode == .custom {
                    Picker("Proxy type", selection: proxyBinding(\.type)) {
                        ForEach(ProxyType.allCases, id: \.self) { type in
                            Text(type.title)
                                .tag(type)
                        }
                    }

                    Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 10) {
                        GridRow {
                            Text("IP or Host")
                            TextField("127.0.0.1", text: proxyBinding(\.host))
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.body, design: .monospaced))
                        }

                        GridRow {
                            Text("Port")
                            TextField("8080", value: proxyBinding(\.port), format: .number)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: 110)
                        }
                    }
                }

                Text(networkSummary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    private var networkSummary: String {
        switch settings.proxySettings.mode {
        case .none:
            "Downloads ignore configured proxies."
        case .system:
            "Downloads use the matching macOS system proxy when one is configured."
        case .custom:
            if let proxyURI = settings.proxySettings.customProxyURI {
                "Downloads use \(proxyURI)."
            } else {
                "Enter a proxy host and port to enable the custom proxy."
            }
        }
    }

    private func proxyBinding<Value>(_ keyPath: WritableKeyPath<ProxySettings, Value>) -> Binding<Value> {
        Binding {
            settings.proxySettings[keyPath: keyPath]
        } set: { newValue in
            var proxySettings = settings.proxySettings
            proxySettings[keyPath: keyPath] = newValue
            settings.proxySettings = proxySettings
        }
    }
}

private struct DownloadSettingsPane: View {
    @EnvironmentObject private var settings: AppSettings

    var body: some View {
        Form {
            Section {
                Stepper(
                    "Default connections per server: \(settings.perServerConnections)",
                    value: $settings.perServerConnections,
                    in: 1...16
                )
                Text("Used as the default for new downloads. The Add Downloads window can override it per batch.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Stepper(
                    "Parallel downloads: \(settings.maxConcurrentDownloads)",
                    value: $settings.maxConcurrentDownloads,
                    in: 1...12
                )
                Text("Controls how many files Firelink downloads at the same time.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

        }
        .formStyle(.grouped)
    }
}

private struct LocationsSettingsPane: View {
    @EnvironmentObject private var settings: AppSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(DownloadCategory.allCases, id: \.self) { category in
                DirectoryPickerRow(category: category)
            }

            HStack {
                Spacer()
                Button("Reset Defaults") {
                    settings.resetDirectories()
                }
            }
        }
    }
}

private struct DirectoryPickerRow: View {
    @EnvironmentObject private var settings: AppSettings
    let category: DownloadCategory

    @State private var path = ""

    var body: some View {
        HStack(spacing: 10) {
            Label(category.rawValue, systemImage: category.symbolName)
                .frame(width: 125, alignment: .leading)

            TextField("Folder path", text: Binding(
                get: { settings.downloadDirectories[category] ?? path },
                set: { newValue in
                    path = newValue
                    settings.setDirectory(newValue, for: category)
                }
            ))
            .textFieldStyle(.roundedBorder)
            .font(.system(.body, design: .monospaced))

            Button {
                selectFolder()
            } label: {
                Label("Select", systemImage: "folder.badge.plus")
            }
        }
    }

    private func selectFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.directoryURL = settings.destinationDirectory(for: category)

        if panel.runModal() == .OK, let url = panel.url {
            settings.setDirectory(url.path, for: category)
        }
    }
}

private struct SiteLoginsSettingsPane: View {
    @EnvironmentObject private var settings: AppSettings
    @State private var urlPattern = ""
    @State private var username = ""
    @State private var password = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 10) {
                GridRow {
                    Text("URL Pattern")
                    TextField("*.github.com", text: $urlPattern)
                        .textFieldStyle(.roundedBorder)
                }

                GridRow {
                    Text("Username")
                    TextField("Username", text: $username)
                        .textFieldStyle(.roundedBorder)
                }

                GridRow {
                    Text("Password")
                    SecureField("Password", text: $password)
                        .textFieldStyle(.roundedBorder)
                }
            }

            HStack {
                Text(settings.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
                Button {
                    settings.addSiteLogin(urlPattern: urlPattern, username: username, password: password)
                    if settings.message.hasPrefix("Added") {
                        urlPattern = ""
                        username = ""
                        password = ""
                    }
                } label: {
                    Label("Add Login", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
            }

            List {
                ForEach(settings.siteLogins) { login in
                    HStack {
                        Image(systemName: "key.horizontal")
                            .foregroundStyle(.secondary)
                        Text(login.urlPattern)
                            .font(.system(.body, design: .monospaced))
                        Spacer()
                        Text(login.username)
                            .foregroundStyle(.secondary)
                    }
                }
                .onDelete(perform: settings.deleteSiteLogins)
            }
            .frame(minHeight: 180)
        }
    }
}

private struct PowerSettingsPane: View {
    @EnvironmentObject private var settings: AppSettings

    var body: some View {
        Form {
            Section {
                Toggle("Prevent system sleep while downloads are active", isOn: $settings.preventsSleepWhileDownloading)
                Text("The display may still turn off. Firelink only keeps macOS awake enough to finish active downloads.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

private struct IntegrationSettingsPane: View {
    @State private var copiedExtensionURL: URL?
    @State private var installMessage = ""

    var body: some View {
        Form {
            Section {
                HStack(alignment: .center, spacing: 14) {
                    Image(systemName: "puzzlepiece.extension")
                        .resizable()
                        .frame(width: 48, height: 48)
                        .foregroundStyle(.orange)
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Firefox Extension")
                            .font(.title2.weight(.semibold))
                        Text("Capture downloads directly from your browser.")
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }
            
            Section("Installation") {
                HStack(spacing: 10) {
                    Button {
                        copyExtensionToDownloads()
                    } label: {
                        Label("Copy to Downloads", systemImage: "folder.badge.plus")
                    }
                    
                    Button {
                        showCopiedExtensionInFinder()
                    } label: {
                        Label("Show Copied Folder", systemImage: "folder.fill")
                    }
                    .disabled(copiedExtensionURL == nil)

                    Button {
                        openFirefoxDebugging()
                    } label: {
                        Label("Open Firefox Debugging", systemImage: "link")
                    }
                }
                .buttonStyle(.borderedProminent)

                if !installMessage.isEmpty {
                    Text(installMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                
                Text("Until the official Firefox Add-ons listing is approved, load the extension manually:\n1. Click 'Copy to Downloads'.\n2. Click 'Open Firefox Debugging'.\n3. Click 'This Firefox' on the left sidebar.\n4. Click 'Load Temporary Add-on' and select manifest.json inside Downloads/Firelink Firefox Extension.\n\nKeep the copied folder while Firefox is running. Temporary add-ons are removed when Firefox restarts, so you can delete the folder after restart or after installing the official add-on.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            
            Section("Permissions & Privacy") {
                Text("The Firelink extension uses download, context menu, storage, active tab, scripting, and local Firelink endpoint permissions. It reads the active tab URL for per-site settings and explicit right-click actions, and forwards download URLs only when you use a Firelink action or enable global capture.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onAppear {
            if FileManager.default.fileExists(atPath: downloadsExtensionURL.path) {
                copiedExtensionURL = downloadsExtensionURL
            }
        }
    }
    
    private var downloadsExtensionURL: URL {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Downloads")
        return downloads.appendingPathComponent("Firelink Firefox Extension", isDirectory: true)
    }

    private func copyExtensionToDownloads() {
        guard let sourceURL = Bundle.main.url(forResource: "FirefoxExtension", withExtension: nil) else {
            installMessage = "The bundled Firefox extension folder was not found."
            return
        }

        let destinationURL = downloadsExtensionURL
        do {
            if FileManager.default.fileExists(atPath: destinationURL.path) {
                try FileManager.default.removeItem(at: destinationURL)
            }

            try FileManager.default.copyItem(at: sourceURL, to: destinationURL)
            copiedExtensionURL = destinationURL
            installMessage = "Copied to \(destinationURL.path). Select manifest.json from this folder in Firefox."
            showCopiedExtensionInFinder()
        } catch {
            installMessage = "Could not copy the extension to Downloads: \(error.localizedDescription)"
        }
    }

    private func showCopiedExtensionInFinder() {
        let folderURL = copiedExtensionURL ?? downloadsExtensionURL
        let manifestURL = folderURL.appendingPathComponent("manifest.json")
        if FileManager.default.fileExists(atPath: manifestURL.path) {
            NSWorkspace.shared.activateFileViewerSelecting([manifestURL])
        } else if FileManager.default.fileExists(atPath: folderURL.path) {
            NSWorkspace.shared.activateFileViewerSelecting([folderURL])
        }
    }

    private func openFirefoxDebugging() {
        let bundleIDs = [
            "org.mozilla.firefoxdeveloperedition",
            "org.mozilla.firefox",
            "org.mozilla.nightly"
        ]
        
        let workspace = NSWorkspace.shared
        for id in bundleIDs {
            if let appURL = workspace.urlForApplication(withBundleIdentifier: id) {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                process.arguments = ["-a", appURL.path, "about:debugging"]
                try? process.run()
                return
            }
        }
        
        // Fallback
        if let fallbackURL = URL(string: "about:debugging") {
            workspace.open(fallbackURL)
        }
    }
}
