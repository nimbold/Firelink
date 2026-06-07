import SwiftUI
import Sparkle

final class SparkleUpdater: NSObject, ObservableObject, SPUUpdaterDelegate {
    private var _updater: SPUUpdater?
    var updater: SPUUpdater { _updater! }

    @Published var isChecking = false
    @Published var isDownloading = false
    @Published var isExtracting = false
    @Published var isReadyToInstall = false
    @Published var downloadProgress: Double = 0.0
    @Published var extractionProgress: Double = 0.0

    @Published var updateStatus: String?
    @Published var foundUpdateItem: SUAppcastItem?
    @Published var releaseNotes: String?

    var expectedContentLength: UInt64 = 0
    var receivedContentLength: UInt64 = 0
    var cancellation: (() -> Void)?
    var updateChoiceReply: ((SPUUserUpdateChoice) -> Void)?

    override init() {
        super.init()
        let driver = InlineUpdateUserDriver(updater: self)
        let hostBundle = Bundle.main
        self._updater = SPUUpdater(hostBundle: hostBundle, applicationBundle: hostBundle, userDriver: driver, delegate: self)
        do {
            try self._updater?.start()
        } catch {
            print("Failed to start Sparkle updater: \(error)")
        }
    }

    func checkForUpdates() {
        guard updater.canCheckForUpdates else {
            isChecking = false
            updateStatus = "Update check is already in progress."
            return
        }
        updater.checkForUpdates()
    }

    func resetState() {
        isChecking = false
        isDownloading = false
        isExtracting = false
        isReadyToInstall = false
        downloadProgress = 0.0
        extractionProgress = 0.0
        updateStatus = nil
        foundUpdateItem = nil
        releaseNotes = nil
        expectedContentLength = 0
        receivedContentLength = 0
        cancellation = nil
        updateChoiceReply = nil
    }

    // Delegate methods can be left mostly empty or minimal since the UserDriver handles the UI state now.
    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        DispatchQueue.main.async {
            self.isChecking = false
        }
    }
}

@main
struct FirelinkApp: App {
    @StateObject private var sparkleUpdater: SparkleUpdater

    @StateObject private var settings: AppSettings
    @StateObject private var controller: DownloadController
    @StateObject private var schedulerController: SchedulerController
    @AppStorage("showMenuBarIcon") private var showMenuBarIcon = true

    // Server must be retained to keep listening
    private let extensionServer: LocalExtensionServer?

    init() {
        self._sparkleUpdater = StateObject(wrappedValue: SparkleUpdater())

        let settings = AppSettings()
        let controller = DownloadController(settings: settings)
        _settings = StateObject(wrappedValue: settings)
        _controller = StateObject(wrappedValue: controller)
        _schedulerController = StateObject(wrappedValue: SchedulerController(downloadController: controller))

        extensionServer = LocalExtensionServer(downloadController: controller)
        extensionServer?.start()
        controller.extensionServerPort = extensionServer?.port
    }

    var body: some Scene {
        WindowGroup(id: "main") {
            ContentView()
                .environmentObject(controller)
                .environmentObject(settings)
                .environmentObject(schedulerController)
                .environmentObject(sparkleUpdater)
                .modifier(AppThemeModifier(theme: settings.appTheme))
                .modifier(AppFontSizeModifier(fontSize: settings.appFontSize))
                .onOpenURL { url in
                    controller.pendingPasteboardText = url.absoluteString
                    controller.pendingReferer = nil
                    NotificationCenter.default.post(name: NSNotification.Name("OpenAddDownloadsWindow"), object: nil)
                }
                .frame(minWidth: 1180, idealWidth: 1280, minHeight: 720, idealHeight: 760)
        }
        .windowStyle(.titleBar)

        WindowGroup("Add Downloads", id: "add-downloads") {
            AddDownloadsView()
                .environmentObject(controller)
                .environmentObject(settings)
                .modifier(AppThemeModifier(theme: settings.appTheme))
                .modifier(AppFontSizeModifier(fontSize: settings.appFontSize))
        }
        .windowResizability(.contentSize)

        WindowGroup("Download Properties", id: "download-properties", for: UUID.self) { $downloadID in
            if let downloadID {
                DownloadPropertiesWindow(downloadID: downloadID)
                    .environmentObject(controller)
                    .environmentObject(settings)
                    .modifier(AppThemeModifier(theme: settings.appTheme))
                    .modifier(AppFontSizeModifier(fontSize: settings.appFontSize))
            } else {
                ContentUnavailableView("Download Not Found", systemImage: "questionmark.circle")
                    .modifier(AppThemeModifier(theme: settings.appTheme))
                    .modifier(AppFontSizeModifier(fontSize: settings.appFontSize))
            }
        }
        .windowResizability(.contentSize)

        .commands {
            CommandGroup(after: .newItem) {
                Button("Add Downloads...") {
                    NotificationCenter.default.post(name: NSNotification.Name("OpenAddDownloadsWindow"), object: nil)
                }
                .keyboardShortcut("n", modifiers: [.command])

                Divider()

                Button("Start Queue") {
                    controller.startQueue()
                }
                .keyboardShortcut("r", modifiers: [.command])

                Button("Stop Downloads") {
                    controller.pauseActiveDownloads()
                }
                .disabled(controller.activeCount == 0)
            }
        }

        MenuBarExtra(isInserted: $showMenuBarIcon) {
            TrayMenuView()
                .environmentObject(controller)
                .environmentObject(sparkleUpdater)
        } label: {
            if let nsImage = { () -> NSImage? in
                guard let url = menuBarIconURL(),
                      let img = NSImage(contentsOf: url) else { return nil }
                img.size = NSSize(width: 23, height: 23)
                img.isTemplate = true
                return img
            }() {
                Image(nsImage: nsImage)
            } else {
                Image(systemName: "arrow.down.circle")
            }
        }
    }

    private func menuBarIconURL() -> URL? {
        if let bundled = Bundle.main.url(forResource: "MenuBarIconTemplate", withExtension: "png") {
            return bundled
        }

        let sourceFile = URL(fileURLWithPath: #filePath)
        let projectRoot = sourceFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sourceTreeIcon = projectRoot
            .appendingPathComponent("Sources/Firelink/Assets.xcassets/MenuBarIcon.imageset/MenuBarIconTemplate.png")
        return FileManager.default.fileExists(atPath: sourceTreeIcon.path) ? sourceTreeIcon : nil
    }
}
