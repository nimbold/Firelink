import SwiftUI
import UniformTypeIdentifiers

enum DownloadSidebarFilter: Hashable {
    case all
    case queued
    case active
    case completed
    case unfinished
    case category(DownloadCategory)

    var title: String {
        switch self {
        case .all: "All Downloads"
        case .queued: "Queue"
        case .active: "Active"
        case .completed: "Completed"
        case .unfinished: "Unfinished"
        case .category(let category): category.rawValue
        }
    }
}

enum SettingsSidebarFilter: String, CaseIterable, Hashable {
    case downloads = "Downloads"
    case lookAndFeel = "Look and feel"
    case network = "Network"
    case locations = "Locations"
    case siteLogins = "Site Logins"
    case power = "Power"
    case engine = "Engine"
    case integration = "Integrations"
    case about = "About"

    var symbolName: String {
        switch self {
        case .downloads: "arrow.down.circle"
        case .lookAndFeel: "paintpalette"
        case .network: "network"
        case .locations: "folder"
        case .siteLogins: "key.fill"
        case .power: "moon.zzz"
        case .engine: "terminal"
        case .integration: "puzzlepiece.extension"
        case .about: "info.circle"
        }
    }
}

enum SidebarSelection: Hashable {
    case downloads(DownloadSidebarFilter)
    case queue(UUID)
    case scheduler
    case speedLimiter
    case settings
}

struct SidebarView: View {
    @EnvironmentObject private var controller: DownloadController
    @Binding var selection: SidebarSelection
    @State private var queueBeingRenamed: DownloadQueue?
    @State private var queueBeingRemoved: DownloadQueue?
    @State private var queueName = ""

    var body: some View {
        List(selection: $selection) {
            Section("Library") {
                Label("All", systemImage: "tray.full")
                    .badge(controller.downloads.count)
                    .tag(SidebarSelection.downloads(.all))
                Label("Active", systemImage: "bolt.fill")
                    .badge(controller.activeCount)
                    .tag(SidebarSelection.downloads(.active))
                Label("Completed", systemImage: "checkmark.circle")
                    .badge(controller.completedCount)
                    .tag(SidebarSelection.downloads(.completed))
                Label("Unfinished", systemImage: "circle.dashed")
                    .badge(controller.unfinishedCount)
                    .tag(SidebarSelection.downloads(.unfinished))
            }

            Section("Folders") {
                ForEach(DownloadCategory.allCases, id: \.self) { category in
                    folderRow(for: category)
                }
            }

            Section("Queues") {
                ForEach(controller.queues) { queue in
                    queueRow(for: queue)
                }

                Button {
                    let queue = controller.addQueue()
                    selection = .queue(queue.id)
                } label: {
                    Label("Add new queue", systemImage: "plus")
                }
                .buttonStyle(.plain)
            }
            
            Section("Tools") {
                Label("Scheduler", systemImage: "calendar.badge.clock")
                    .tag(SidebarSelection.scheduler)
                Label("Speed Limiter", systemImage: "speedometer")
                    .tag(SidebarSelection.speedLimiter)
            }

        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 0) {
                Divider()
                Button {
                    selection = .settings
                } label: {
                    Label("Settings", systemImage: "gearshape")
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .background(selection == .settings ? Color.accentColor : Color.clear)
                .foregroundStyle(selection == .settings ? Color.white : Color.primary)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .padding(.horizontal, 8)
                .padding(.vertical, 8)
            }
            .background(.regularMaterial)
        }
        .alert("Rename Queue", isPresented: Binding(
            get: { queueBeingRenamed != nil },
            set: { isPresented in
                if !isPresented {
                    queueBeingRenamed = nil
                }
            }
        )) {
            TextField("Queue name", text: $queueName)
            Button("Rename") {
                if let queue = queueBeingRenamed {
                    controller.renameQueue(id: queue.id, name: queueName)
                }
                queueBeingRenamed = nil
            }
            Button("Cancel", role: .cancel) {
                queueBeingRenamed = nil
            }
        }
        .confirmationDialog(
            "Delete Queue",
            isPresented: Binding(
                get: { queueBeingRemoved != nil },
                set: { isPresented in
                    if !isPresented {
                        queueBeingRemoved = nil
                    }
                }
            ),
            presenting: queueBeingRemoved
        ) { queue in
            Button("Delete Queue", role: .destructive) {
                controller.removeQueue(id: queue.id)
                if selection == .queue(queue.id) {
                    selection = .downloads(.unfinished)
                }
                queueBeingRemoved = nil
            }
            Button("Cancel", role: .cancel) {
                queueBeingRemoved = nil
            }
        } message: { queue in
            Text("Downloads in \(queue.name) will stay in All and Unfinished, but no longer belong to a queue.")
        }
    }

    private func folderRow(for category: DownloadCategory) -> some View {
        Label(category.rawValue, systemImage: category.symbolName)
            .badge(controller.downloads.filter { $0.category == category }.count)
            .tag(SidebarSelection.downloads(.category(category)))
    }

    private func queueRow(for queue: DownloadQueue) -> some View {
        Label(queue.name, systemImage: queue.isMain ? "list.bullet.rectangle" : "list.bullet")
            .badge(controller.queueCount(for: queue.id))
            .tag(SidebarSelection.queue(queue.id))
            .onDrop(
                of: [.text],
                delegate: QueueSidebarDropDelegate(
                    queueID: queue.id,
                    selection: $selection,
                    controller: controller
                )
            )
            .contextMenu {
                if !queue.isMain {
                    Button("Rename") {
                        queueBeingRenamed = queue
                        queueName = queue.name
                    }
                    Button("Delete", role: .destructive) {
                        queueBeingRemoved = queue
                    }
                }
            }
    }
}

private struct QueueSidebarDropDelegate: DropDelegate {
    let queueID: UUID
    @Binding var selection: SidebarSelection
    let controller: DownloadController

    func performDrop(info: DropInfo) -> Bool {
        guard let provider = info.itemProviders(for: [.text]).first else {
            return false
        }

        provider.loadItem(forTypeIdentifier: UTType.text.identifier, options: nil) { item, _ in
            guard let itemIDs = Self.itemIDs(from: item), !itemIDs.isEmpty else { return }
            Task { @MainActor in
                controller.assignToQueue(itemIDs: itemIDs, queueID: queueID)
                selection = .queue(queueID)
            }
        }
        return true
    }

    nonisolated private static func itemIDs(from item: NSSecureCoding?) -> Set<UUID>? {
        let text: String?
        if let data = item as? Data {
            text = String(data: data, encoding: .utf8)
        } else {
            text = item as? String
        }

        guard let text else { return nil }
        return Set(text
            .split(whereSeparator: { $0 == "\n" || $0 == "," || $0 == " " })
            .compactMap { UUID(uuidString: String($0)) })
    }
}
