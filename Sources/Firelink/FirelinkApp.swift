import SwiftUI
import Sparkle

final class SparkleUpdater: NSObject, ObservableObject, SPUUpdaterDelegate {
    private var _controller: SPUStandardUpdaterController?
    var controller: SPUStandardUpdaterController { _controller! }
    
    @Published var isChecking = false
    @Published var updateStatus: String?
    @Published var foundUpdateItem: SUAppcastItem?

    override init() {
        super.init()
        self._controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
    }
    
    func checkForUpdates() {
        isChecking = true
        updateStatus = "Checking for updates..."
        foundUpdateItem = nil
        controller.updater.checkForUpdatesInBackground()
    }

    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        DispatchQueue.main.async {
            self.isChecking = false
            self.foundUpdateItem = item
            self.updateStatus = "Update available: Version \(item.displayVersionString)"
        }
    }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater, error: Error) {
        DispatchQueue.main.async {
            self.isChecking = false
            let version = updater.hostBundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
            let build = updater.hostBundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
            self.updateStatus = "You're up to date! (Version \(version) (\(build)))"
        }
    }
    
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        DispatchQueue.main.async {
            self.isChecking = false
            let nsError = error as NSError
            if nsError.domain == "SUSparkleErrorDomain" && nsError.code == 1002 {
                // SUNoUpdateError, handled by updaterDidNotFindUpdate
            } else {
                self.updateStatus = "Update check failed: \(error.localizedDescription)"
            }
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

        WindowGroup("Download Properties", for: UUID.self) { $downloadID in
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
