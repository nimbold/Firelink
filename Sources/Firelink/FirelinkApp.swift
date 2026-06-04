import SwiftUI

@main
struct FirelinkApp: App {
    @StateObject private var settings: AppSettings
    @StateObject private var controller: DownloadController
    @StateObject private var schedulerController: SchedulerController
    @AppStorage("showMenuBarIcon") private var showMenuBarIcon = true
    
    // Server must be retained to keep listening
    private let extensionServer: LocalExtensionServer?

    init() {
        let settings = AppSettings()
        let controller = DownloadController(settings: settings)
        _settings = StateObject(wrappedValue: settings)
        _controller = StateObject(wrappedValue: controller)
        _schedulerController = StateObject(wrappedValue: SchedulerController(downloadController: controller))
        
        extensionServer = LocalExtensionServer(downloadController: controller)
        extensionServer?.start()
    }

    var body: some Scene {
        WindowGroup(id: "main") {
            ContentView()
                .environmentObject(controller)
                .environmentObject(settings)
                .environmentObject(schedulerController)
                .modifier(AppThemeModifier(theme: settings.appTheme))
                .modifier(AppFontSizeModifier(fontSize: settings.appFontSize))
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
                Button("Start Queue") {
                    controller.startQueue()
                }
                .keyboardShortcut("r", modifiers: [.command])
            }
        }

        MenuBarExtra(isInserted: $showMenuBarIcon) {
            TrayMenuView()
                .environmentObject(controller)
        } label: {
            if let nsImage = { () -> NSImage? in
                guard let url = Bundle.main.url(forResource: "MenuBarIconTemplate", withExtension: "png"),
                      let img = NSImage(contentsOf: url) else { return nil }
                img.size = NSSize(width: 21, height: 21)
                img.isTemplate = true
                return img
            }() {
                Image(nsImage: nsImage)
            } else {
                Image(systemName: "arrow.down.circle")
            }
        }
    }
}
