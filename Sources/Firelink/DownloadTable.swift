import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct DownloadTable: View {
    @EnvironmentObject private var controller: DownloadController
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.openWindow) private var openWindow
    let items: [DownloadItem]
    @Binding var selection: Set<DownloadItem.ID>
    let title: String
    var queueID: UUID?

    @State private var sortOrder = [KeyPathComparator(\DownloadItem.createdAt, order: .reverse)]
    @State private var pendingDeleteItems: Set<DownloadItem.ID>?

    var sortedItems: [DownloadItem] {
        items.sorted(using: sortOrder)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(title)
                    .font(.headline)
                Text("\(items.count)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(.quaternary.opacity(0.5))
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            Table(sortedItems, selection: $selection, sortOrder: $sortOrder) {
                TableColumn("File Name", value: \.fileName) { item in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: item.category.symbolName)
                            .font(.title3)
                            .foregroundStyle(categoryColor(for: item.category))
                            .frame(width: 22)
                        Text(item.fileName)
                            .font(.headline)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }
                .width(min: 200, ideal: 340)

                TableColumn("Size", value: \.sortableSize) { item in
                    Text(ByteFormatter.string(item.sizeBytes))
                        .monospacedDigit()
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .width(min: 80, ideal: 100)

                TableColumn("Progress", value: \.progress) { item in
                    progressBarCell(for: item)
                }
                .width(min: 100, ideal: 115)

                TableColumn("Status", value: \.status.rawValue) { item in
                    Text(item.status.rawValue)
                }
                .width(min: 80, ideal: 105)

                TableColumn("Speed", value: \.speedText) { item in
                    Text(item.speedText)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .width(min: 70, ideal: 90)

                TableColumn("ETA", value: \.etaText) { item in
                    Text(item.etaText)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .width(min: 70, ideal: 90)

                TableColumn("Date Added", value: \.createdAt) { item in
                    Text(formatted(item.createdAt))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .width(min: 100, ideal: 155)
            }
            .contextMenu(forSelectionType: DownloadItem.ID.self) { itemIDs in
                rowContextMenu(for: itemIDs)
            } primaryAction: { itemIDs in
                for itemID in itemIDs {
                    if let item = controller.downloads.first(where: { $0.id == itemID }) {
                        if item.status == .completed {
                            openFile(item)
                        } else {
                            openWindow(value: item.id)
                        }
                    }
                }
            }
            .overlay {
                if items.isEmpty {
                    ContentUnavailableView(
                        "No Downloads",
                        systemImage: "arrow.down.circle",
                        description: Text("Use Add or press \(Image(systemName: "command"))V to paste one or more links.")
                    )
                }
            }
        }
        .confirmationDialog(
            "Delete Download",
            isPresented: Binding(
                get: { pendingDeleteItems != nil },
                set: { isPresented in
                    if !isPresented {
                        pendingDeleteItems = nil
                    }
                }
            ),
            presenting: pendingDeleteItems
        ) { ids in
            Button("Remove from List") {
                let items = controller.downloads.filter { ids.contains($0.id) }
                for item in items { controller.delete(item, deleteFiles: false) }
                selection.subtract(ids)
                pendingDeleteItems = nil
            }

            Button("Move to Trash", role: .destructive) {
                let items = controller.downloads.filter { ids.contains($0.id) }
                for item in items { controller.delete(item, deleteFiles: true) }
                selection.subtract(ids)
                pendingDeleteItems = nil
            }

            Button("Cancel", role: .cancel) {
                pendingDeleteItems = nil
            }
        } message: { ids in
            let items = controller.downloads.filter { ids.contains($0.id) }
            if items.allSatisfy({ $0.status == .completed }) {
                Text("Remove \(items.count == 1 ? "this download" : "these \(items.count) downloads") from Firelink, or also move the downloaded files to Trash.")
            } else {
                Text("Remove \(items.count == 1 ? "this download" : "these \(items.count) downloads") from Firelink. Partial cache files are removed automatically; moving to Trash also sends any partial files there.")
            }
        }
    }

    @ViewBuilder
    private func rowContextMenu(for itemIDs: Set<DownloadItem.ID>) -> some View {
        let targetItems = controller.downloads.filter { itemIDs.contains($0.id) }

        if !targetItems.isEmpty {
            if targetItems.allSatisfy({ $0.status == .completed }) {
                Button {
                    for target in targetItems {
                        openFile(target)
                    }
                } label: {
                    Label(targetItems.count > 1 ? "Open (\(targetItems.count))" : "Open", systemImage: "doc")
                }
            }

            Button {
                for target in targetItems {
                    showInFinder(target)
                }
            } label: {
                Label(targetItems.count > 1 ? "Show in Finder (\(targetItems.count))" : "Show in Finder", systemImage: "finder")
            }

            Divider()

            if targetItems.contains(where: { $0.status == .paused || $0.status == .failed || $0.status == .canceled }) {
                Button {
                    for target in targetItems where target.status == .paused || target.status == .failed || target.status == .canceled {
                        controller.resume(target)
                    }
                } label: {
                    Label("Start", systemImage: "play.fill")
                }
            }

            if targetItems.contains(where: { $0.status == .downloading || $0.status == .queued }) {
                Button {
                    for target in targetItems where target.status == .downloading || target.status == .queued {
                        controller.pause(target)
                    }
                } label: {
                    Label("Stop", systemImage: "stop.fill")
                }
            }

            if targetItems.contains(where: { $0.status == .completed || $0.status == .failed || $0.status == .canceled }) {
                Button {
                    for target in targetItems where target.status == .completed || target.status == .failed || target.status == .canceled {
                        controller.redownload(target)
                    }
                } label: {
                    Label("Redownload", systemImage: "arrow.clockwise")
                }
            }

            Divider()

            if targetItems.contains(where: { $0.status != .completed && $0.status != .downloading }) {
                Menu {
                    ForEach(controller.queues) { queue in
                        Button(queue.name) {
                            controller.assignToQueue(
                                itemIDs: Set(targetItems.map(\.id)),
                                queueID: queue.id
                            )
                        }
                    }
                } label: {
                    Label("Move to Queue", systemImage: "list.bullet")
                }
                Divider()
            }

            Button {
                NSPasteboard.general.clearContents()
                let urls = targetItems.map { $0.url.absoluteString }.joined(separator: "\n")
                NSPasteboard.general.setString(urls, forType: .string)
            } label: {
                Label(targetItems.count > 1 ? "Copy Addresses" : "Copy Address", systemImage: "link")
            }

            Button {
                for target in targetItems {
                    openWindow(value: target.id)
                }
            } label: {
                Label(targetItems.count > 1 ? "Properties (\(targetItems.count))" : "Properties", systemImage: "info.circle")
            }

            Divider()

            Button(role: .destructive) {
                pendingDeleteItems = itemIDs
            } label: {
                Label("Remove", systemImage: "trash")
            }
        }
    }

    private func categoryColor(for category: DownloadCategory) -> Color {
        switch category {
        case .musics: return .pink
        case .movies: return .indigo
        case .compressed: return .orange
        case .pictures: return .teal
        case .documents: return .blue
        case .other: return .gray
        }
    }

    private func statusColor(for status: DownloadStatus) -> Color {
        switch status {
        case .queued: return .secondary
        case .downloading: return .blue
        case .paused: return .orange
        case .completed: return .green
        case .failed: return .red
        case .canceled: return .gray
        }
    }

    @ViewBuilder
    private func progressBarCell(for item: DownloadItem) -> some View {
        if item.status == .completed {
            Text("Completed")
                .foregroundStyle(.green)
                .lineLimit(1)
                .truncationMode(.tail)
        } else {
            GeometryReader { proxy in
                ZStack {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color.secondary.opacity(0.15))
                    
                    RoundedRectangle(cornerRadius: 4)
                        .fill(statusColor(for: item.status))
                        .frame(width: max(0, proxy.size.width * item.progress))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    
                    Text(item.progress.formatted(.percent.precision(.fractionLength(0))))
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundColor(.primary)
                }
            }
            .frame(height: 16)
        }
    }

    private func formatted(_ date: Date?) -> String {
        guard let date else { return "-" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private func showInFinder(_ item: DownloadItem) {
        let fileURL = item.destinationDirectory.appendingPathComponent(item.fileName)
        if FileManager.default.fileExists(atPath: fileURL.path) {
            NSWorkspace.shared.activateFileViewerSelecting([fileURL])
        } else {
            NSWorkspace.shared.open(existingFolder(for: item.destinationDirectory))
        }
    }

    private func existingFolder(for url: URL) -> URL {
        var candidate = url
        while !FileManager.default.fileExists(atPath: candidate.path) {
            let parent = candidate.deletingLastPathComponent()
            if parent.path == candidate.path {
                return URL(fileURLWithPath: NSHomeDirectory())
            }
            candidate = parent
        }
        return candidate
    }

    private func openFile(_ item: DownloadItem) {
        let fileURL = item.destinationDirectory.appendingPathComponent(item.fileName)
        if FileManager.default.fileExists(atPath: fileURL.path) {
            NSWorkspace.shared.open(fileURL)
        } else {
            NSWorkspace.shared.open(existingFolder(for: item.destinationDirectory))
        }
    }
}
