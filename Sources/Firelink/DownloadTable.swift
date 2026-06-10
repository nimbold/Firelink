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
    @State private var sortedItems: [DownloadItem] = []

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(title)
                    .font(.title2)
                    .fontWeight(.semibold)
                Text("\(items.count)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.quaternary.opacity(0.5))
                    .clipShape(Capsule())
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            if items.isEmpty {
                ContentUnavailableView(
                    "No Downloads",
                    systemImage: "arrow.down.circle",
                    description: Text("Use Add or press \(Image(systemName: "command"))V to paste one or more links.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
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
                                .allowsHitTesting(false)
                        }
                        .draggable(item.id.uuidString)
                    }
                    .width(min: 200, ideal: 340)

                    TableColumn("Size", value: \.sortableSize) { item in
                        if let size = item.sizeBytes, size > 0 {
                            Text(ByteFormatter.string(size))
                                .monospacedDigit()
                                .lineLimit(1)
                                .truncationMode(.tail)
                        } else if item.bytesText != "-" && !item.bytesText.isEmpty {
                            Text(item.bytesText)
                                .monospacedDigit()
                                .lineLimit(1)
                                .truncationMode(.tail)
                        } else {
                            Text("Unknown")
                                .monospacedDigit()
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                    }
                    .width(min: 80, ideal: 100)

                    TableColumn("Status", value: \.status.rawValue) { item in
                        combinedStatusCell(for: item)
                    }
                    .width(min: 160, ideal: 200)

                    TableColumn("Speed", value: \.displaySpeedText) { item in
                        if item.status == .downloading {
                            formattedSpeedCell(for: item.displaySpeedText)
                        } else {
                            Text("-")
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .width(min: 80, ideal: 100)

                    TableColumn("ETA", value: \.displayETAText) { item in
                        if item.status == .downloading {
                            formattedETACell(for: item.displayETAText)
                        } else {
                            Text("-")
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .width(min: 80, ideal: 100)

                    TableColumn("Date Added", value: \.createdAt) { item in
                        Text(formatted(item.createdAt))
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    .width(min: 100, ideal: 155)
                }
                .environment(\.defaultMinListRowHeight, settings.listRowDensity.minRowHeight)
                .animation(.default, value: sortedItems)
                .contextMenu(forSelectionType: DownloadItem.ID.self) { itemIDs in
                    rowContextMenu(for: itemIDs)
                } primaryAction: { itemIDs in
                    let targetItems = controller.downloads.filter { itemIDs.contains($0.id) }
                    for target in targetItems {
                        if target.status == .completed {
                            openFile(target)
                        }
                    }
                }
            }
        }
        .onAppear { sortedItems = items.sorted(using: sortOrder) }
        .onChange(of: items) { _, newItems in
            let existingIDs = Set(sortedItems.map(\.id))
            let newIDs = Set(newItems.map(\.id))
            if existingIDs != newIDs {
                sortedItems = newItems.sorted(using: sortOrder)
            } else {
                let itemsDict = Dictionary(uniqueKeysWithValues: newItems.map { ($0.id, $0) })
                sortedItems = sortedItems.compactMap { itemsDict[$0.id] }
            }
        }
        .onChange(of: sortOrder) { _, newOrder in
            sortedItems = items.sorted(using: newOrder)
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
    private func combinedStatusCell(for item: DownloadItem) -> some View {
        if item.status == .completed {
            Text("Completed")
                .foregroundStyle(.green)
                .fontWeight(.medium)
        } else {
            HStack(spacing: 8) {
                ProgressView(value: item.progress)
                    .progressViewStyle(.linear)
                    .tint(statusColor(for: item.status))
                
                if item.status == .downloading {
                    Text(item.progress.formatted(.percent.precision(.fractionLength(0))))
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .frame(width: 35, alignment: .trailing)
                } else {
                    Text(item.status.rawValue.capitalized)
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func parseSpeed(_ text: String) -> [String] {
        var display = text
        
        if let index = display.firstIndex(where: { $0.isLetter }) {
            if display.distance(from: display.startIndex, to: index) > 0 {
                let prevIndex = display.index(before: index)
                if display[prevIndex] != " " {
                    display.insert(" ", at: index)
                }
            }
        }
        return display.split(separator: " ", maxSplits: 1).map(String.init)
    }

    @ViewBuilder
    private func formattedSpeedCell(for text: String) -> some View {
        let components = parseSpeed(text)
        if components.count == 2 {
            HStack(alignment: .firstTextBaseline, spacing: 1) {
                Text(components[0])
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(.primary)
                Text(components[1])
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundStyle(.secondary)
            }
            .lineLimit(1)
            .truncationMode(.tail)
        } else {
            Text(components.joined(separator: " "))
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(.primary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
    }

    @ViewBuilder
    private func formattedETACell(for text: String) -> some View {
        Text(text)
            .font(.system(size: 13, weight: .medium, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(.primary)
            .lineLimit(1)
            .truncationMode(.tail)
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
                Label(targetItems.count > 1 ? "Show in Finder (\(targetItems.count))" : "Show in Finder", systemImage: "magnifyingglass")
            }

            Divider()

            if targetItems.contains(where: { $0.status == .paused || $0.status == .failed || $0.status == .canceled }) {
                Button {
                    for target in targetItems where target.status == .paused || target.status == .failed || target.status == .canceled {
                        controller.resume(target)
                    }
                } label: {
                    Label("Resume", systemImage: "play.fill")
                }
            }

            if targetItems.contains(where: { $0.status == .downloading || $0.status == .queued }) {
                Button {
                    for target in targetItems where target.status == .downloading || target.status == .queued {
                        controller.pause(target)
                    }
                } label: {
                    Label("Pause", systemImage: "pause.fill")
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

            if targetItems.allSatisfy({ $0.status == .completed }) {
                Button {
                    NSPasteboard.general.clearContents()
                    let paths = targetItems.map { $0.destinationPath }.joined(separator: "\n")
                    if !paths.isEmpty {
                        NSPasteboard.general.setString(paths, forType: .string)
                    }
                } label: {
                    Label(targetItems.count > 1 ? "Copy File Paths" : "Copy File Path", systemImage: "doc.on.doc")
                }
            }

            Divider()

            Button(role: .destructive) {
                pendingDeleteItems = itemIDs
            } label: {
                Label("Remove from List", systemImage: "trash")
            }

            Divider()

            Button {
                for target in targetItems {
                    openWindow(id: "download-properties", value: target.id)
                }
            } label: {
                Label(targetItems.count > 1 ? "Properties (\(targetItems.count))" : "Properties", systemImage: "info.circle")
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
