import SwiftUI

@main
struct FirelinkApp: App {
    @StateObject private var updateChecker: ReleaseUpdateChecker
    @StateObject private var settings: AppSettings
    @StateObject private var controller: DownloadController
    @StateObject private var schedulerController: SchedulerController
    @AppStorage("showMenuBarIcon") private var showMenuBarIcon = true
    @State private var lastURLSchemeInvocation: Date = .distantPast
    @State private var urlSchemeInvocationCount: Int = 0

    // Server must be retained to keep listening
    private let extensionServer: LocalExtensionServer?

    init() {
        self._updateChecker = StateObject(wrappedValue: ReleaseUpdateChecker())

        let settings = AppSettings()
        let controller = DownloadController(settings: settings)
        _settings = StateObject(wrappedValue: settings)
        _controller = StateObject(wrappedValue: controller)
        _schedulerController = StateObject(wrappedValue: SchedulerController(downloadController: controller))

        extensionServer = LocalExtensionServer(downloadController: controller, settings: settings)
        extensionServer?.start()
        controller.extensionServerPort = extensionServer?.port
    }

    var body: some Scene {
        WindowGroup(id: "main") {
            ContentView()
                .environmentObject(controller)
                .environmentObject(settings)
                .environmentObject(schedulerController)
                .environmentObject(updateChecker)
                .modifier(AppThemeModifier(theme: settings.appTheme))
                .modifier(AppFontSizeModifier(fontSize: settings.appFontSize))
                .task {
                    updateChecker.checkAutomaticallyIfNeeded()
                    _ = await MediaEngineManager.shared.preparedBinaryPath(for: .ytDlp)
                }
                .onOpenURL { url in
                    let now = Date()
                    if now.timeIntervalSince(lastURLSchemeInvocation) > 5 {
                        urlSchemeInvocationCount = 0
                    }
                    guard urlSchemeInvocationCount < 3 else { return }
                    urlSchemeInvocationCount += 1
                    lastURLSchemeInvocation = now

                    if url.scheme == "firelink" {
                        if url.host == "add",
                           let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                           let queryItems = components.queryItems,
                           let link = queryItems.first(where: { $0.name == "url" })?.value,
                           link.count < 65536 {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                                controller.pendingPasteboardText = link
                                controller.pendingReferer = nil
                                NotificationCenter.default.post(name: NSNotification.Name("OpenAddDownloadsWindow"), object: nil)
                            }
                        }
                        return
                    }
                    
                    guard url.absoluteString.count < 65536 else { return }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        controller.pendingPasteboardText = url.absoluteString
                        controller.pendingReferer = nil
                        NotificationCenter.default.post(name: NSNotification.Name("OpenAddDownloadsWindow"), object: nil)
                    }
                }
                .frame(minWidth: 1180, idealWidth: 1280, minHeight: 720, idealHeight: 760)
        }
        .windowStyle(.titleBar)

        Window("Add Downloads", id: "add-downloads") {
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
