import AppKit
import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var controller: DownloadController
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.openWindow) private var openWindow
    @State private var selection: Set<DownloadItem.ID> = []
    @State private var sidebarSelection: SidebarSelection = .downloads(.all)
    @State private var showDeleteConfirmation = false

    var body: some View {
        NavigationSplitView {
            SidebarView(selection: $sidebarSelection)
                .navigationSplitViewColumnWidth(min: 190, ideal: 220, max: 260)
                .themeBackground(settings.appTheme.theme.secondaryBackground)
        } detail: {
            detailView
                .themeBackground(settings.appTheme.theme.background)
        }
        .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("OpenAddDownloadsWindow"))) { _ in
            openWindow(id: "add-downloads")
        }
        .onDrop(of: [.url, .fileURL, .plainText], isTargeted: nil) { providers in
            for provider in providers {
                if provider.canLoadObject(ofClass: URL.self) {
                    _ = provider.loadObject(ofClass: URL.self) { url, _ in
                        if let url = url {
                            DispatchQueue.main.async {
                                controller.pendingPasteboardText = url.absoluteString
                                openWindow(id: "add-downloads")
                            }
                        }
                    }
                } else if provider.canLoadObject(ofClass: String.self) {
                    _ = provider.loadObject(ofClass: String.self) { text, _ in
                        if let text = text {
                            DispatchQueue.main.async {
                                controller.pendingPasteboardText = text
                                openWindow(id: "add-downloads")
                            }
                        }
                    }
                }
            }
            return true
        }
    }

    @ViewBuilder
    private var detailView: some View {
        switch sidebarSelection {
        case .downloads(let filter):
            downloadsView(filter: filter)
        case .queue(let queueID):
            queueView(queueID: queueID)
        case .scheduler:
            SchedulerView()
        case .speedLimiter:
            SpeedLimiterView()
        case .settings:
            SettingsPaneContainer()
        }
    }

    private func queueView(queueID: UUID) -> some View {
        downloadsView(
            filter: .all,
            title: controller.queueName(for: queueID),
            items: controller.queueItems(for: queueID),
            queueID: queueID
        )
    }

    private func downloadsView(filter: DownloadSidebarFilter) -> some View {
        downloadsView(
            filter: filter,
            title: filter.title,
            items: filteredDownloads(for: filter),
            queueID: nil
        )
    }

    private func downloadsView(filter: DownloadSidebarFilter, title: String, items: [DownloadItem], queueID: UUID?) -> some View {
        VStack(spacing: 0) {
            DownloadTable(
                items: items,
                selection: $selection,
                title: title,
                queueID: queueID
            )
            Divider()
            StatusBar()
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    controller.pendingAddQueueID = queueID
                    openWindow(id: "add-downloads")
                } label: {
                    Label("Add", systemImage: "plus")
                }
            }

            ToolbarItemGroup {
                let canStop = selectedItems.isEmpty ? hasActiveDownloads(in: queueID) : selectedItems.contains(where: { $0.status == .downloading })
                Button {
                    if selectedItems.isEmpty {
                        controller.pauseActiveDownloads(queueID: queueID)
                    } else {
                        for item in selectedItems where item.status == .downloading {
                            controller.pause(item)
                        }
                    }
                } label: {
                    Label(selectedItems.isEmpty ? "Stop All" : "Stop", systemImage: "stop.fill")
                }
                .disabled(!canStop)

                let canStart = selectedItems.isEmpty ? true : selectedItems.contains(where: { $0.status == .paused || $0.status == .failed || $0.status == .canceled })
                Button {
                    if selectedItems.isEmpty {
                        controller.startQueue(queueID: queueID)
                    } else {
                        for item in selectedItems where item.status == .paused || item.status == .failed || item.status == .canceled {
                            controller.resume(item)
                        }
                    }
                } label: {
                    Label(selectedItems.isEmpty ? "Start Queue" : "Start", systemImage: "play.fill")
                }
                .disabled(!canStart)
            }
        }
        .background {
            Button("") {
                if !selection.isEmpty {
                    showDeleteConfirmation = true
                }
            }
            .keyboardShortcut(.delete, modifiers: [])
            .opacity(0)

            Button("") {
                handlePaste(queueID: queueID)
            }
            .keyboardShortcut("v", modifiers: .command)
            .opacity(0)

            Button("") {
                selectAll(items: items)
            }
            .keyboardShortcut("a", modifiers: .command)
            .opacity(0)
        }
        .confirmationDialog(
            "Delete \(selection.count) Download\(selection.count == 1 ? "" : "s")",
            isPresented: $showDeleteConfirmation
        ) {
            Button("Remove from List") {
                deleteSelected(deleteFiles: false)
            }
            Button("Move Files and Cache to Trash", role: .destructive) {
                deleteSelected(deleteFiles: true)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Are you sure you want to delete the selected downloads?")
        }
    }

    private var selectedItems: [DownloadItem] {
        controller.downloads.filter { selection.contains($0.id) }
    }

    private func deleteSelected(deleteFiles: Bool) {
        for item in selectedItems {
            controller.delete(item, deleteFiles: deleteFiles)
        }
        selection.removeAll()
    }
    
    private func handlePaste(queueID: UUID?) {
        guard let text = NSPasteboard.general.string(forType: .string), !text.isEmpty else { return }
        controller.pendingPasteboardText = text
        controller.pendingAddQueueID = queueID
        openWindow(id: "add-downloads")
    }

    private func selectAll(items: [DownloadItem]) {
        selection = Set(items.map { $0.id })
    }

    private func hasActiveDownloads(in queueID: UUID?) -> Bool {
        if let queueID {
            return controller.downloads.contains { $0.status == .downloading && $0.queueID == queueID }
        }

        return controller.activeCount > 0
    }

    private func filteredDownloads(for filter: DownloadSidebarFilter) -> [DownloadItem] {
        switch filter {
        case .all:
            controller.downloads
        case .queued:
            controller.downloads.filter { $0.status == .queued }
        case .active:
            controller.downloads.filter { $0.status == .downloading }
        case .completed:
            controller.downloads.filter { $0.status == .completed }
        case .unfinished:
            controller.downloads.filter { $0.status != .completed }
        case .category(let category):
            controller.downloads.filter { $0.category == category }
        }
    }
}
