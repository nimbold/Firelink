import AppKit
import SwiftUI
import UniformTypeIdentifiers

enum DownloadColumn: String, CaseIterable, Identifiable, Codable {
    case priority = "#"
    case fileName = "File name"
    case size = "Size"
    case progress = "Progress"
    case status = "Status"
    case lastTry = "Last try date"
    case dateAdded = "Date added"
    case category = "Category"
    case connections = "Connections"
    case liveConnections = "Live conn."
    case speed = "Speed"
    case eta = "ETA"
    case destination = "Save location"
    case url = "URL"
    case message = "Message"

    var id: String { rawValue }

    var width: CGFloat {
        switch self {
        case .priority: return 58
        case .fileName: return 340
        case .size: return 100
        case .status: return 105
        case .progress: return 115
        case .lastTry, .dateAdded: return 155
        case .category: return 105
        case .connections, .liveConnections: return 95
        case .speed, .eta: return 90
        case .destination: return 240
        case .url: return 280
        case .message: return 220
        }
    }
}

enum SortDirection: String, Codable {
    case ascending
    case descending

    mutating func toggle() {
        self = self == .ascending ? .descending : .ascending
    }
}

final class TableSettings: ObservableObject {
    @Published var visibleColumns: Set<DownloadColumn> {
        didSet { save() }
    }
    @Published var columnWidths: [DownloadColumn: CGFloat] {
        didSet { save() }
    }
    @Published var sortColumn: DownloadColumn {
        didSet { save() }
    }
    @Published var sortDirection: SortDirection {
        didSet { save() }
    }

    private let defaults = UserDefaults.standard
    private let storageKey = "Firelink.TableSettings.v1"

    init() {
        let defaultVisibleColumns: Set<DownloadColumn> = [.fileName, .size, .progress, .speed, .eta, .dateAdded]
        let legacyDefaultVisibleColumns: Set<DownloadColumn> = [.fileName, .size, .progress, .eta, .lastTry, .dateAdded]

        if let data = defaults.data(forKey: storageKey),
           let stored = try? JSONDecoder().decode(StoredTableSettings.self, from: data) {
            visibleColumns = stored.visibleColumns == legacyDefaultVisibleColumns ? defaultVisibleColumns : stored.visibleColumns
            columnWidths = stored.columnWidths
            sortColumn = stored.sortColumn
            sortDirection = stored.sortDirection
        } else {
            visibleColumns = defaultVisibleColumns
            columnWidths = Dictionary(uniqueKeysWithValues: DownloadColumn.allCases.map { ($0, $0.width) })
            sortColumn = .dateAdded
            sortDirection = .descending
        }
    }

    private func save() {
        let stored = StoredTableSettings(
            visibleColumns: visibleColumns,
            columnWidths: columnWidths,
            sortColumn: sortColumn,
            sortDirection: sortDirection
        )
        if let data = try? JSONEncoder().encode(stored) {
            defaults.set(data, forKey: storageKey)
        }
    }
}

private struct StoredTableSettings: Codable {
    var visibleColumns: Set<DownloadColumn>
    var columnWidths: [DownloadColumn: CGFloat]
    var sortColumn: DownloadColumn
    var sortDirection: SortDirection
}

struct DownloadTable: View {
    @EnvironmentObject private var controller: DownloadController
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.openWindow) private var openWindow
    let items: [DownloadItem]
    @Binding var selection: Set<DownloadItem.ID>
    let title: String
    var queueID: UUID?

    @StateObject private var tableSettings = TableSettings()
    @State private var pendingDeleteItems: Set<DownloadItem.ID>?
    @State private var resizeBaseWidths: [DownloadColumn: CGFloat] = [:]
    @State private var lastSelectedIndex: Int?
    @State private var draggedItemID: DownloadItem.ID?

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
            GeometryReader { proxy in
                let tableWidth = max(totalWidth, proxy.size.width)
                let trailingWidth = max(0, tableWidth - totalWidth)

                ScrollView(.horizontal) {
                    VStack(spacing: 0) {
                        tableHeader(trailingWidth: trailingWidth)
                        Divider()
                        ScrollView(.vertical) {
                            LazyVStack(spacing: 0) {
                                ForEach(sortedItems) { item in
                                    tableRow(for: item, tableWidth: tableWidth, trailingWidth: trailingWidth)
                                    Divider()
                                }
                            }
                            .frame(width: tableWidth, alignment: .topLeading)
                            .frame(maxHeight: .infinity, alignment: .topLeading)
                        }
                        .defaultScrollAnchor(.topLeading)
                    }
                    .frame(width: tableWidth, height: proxy.size.height, alignment: .topLeading)
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

            Button("Move File and Cache to Trash", role: .destructive) {
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

    private func tableRow(for item: DownloadItem, tableWidth: CGFloat, trailingWidth: CGFloat) -> some View {
        DownloadRow(
            item: item,
            priorityNumber: priorityNumber(for: item),
            visibleColumns: orderedVisibleColumns,
            columnWidth: { width(for: $0) },
            trailingWidth: trailingWidth
        )
        .id(item.id)
        .frame(width: tableWidth, alignment: .leading)
        .background(selection.contains(item.id) ? Color.accentColor.opacity(0.12) : Color.clear)
        .contentShape(Rectangle())
        .onTapGesture(count: 2) {
            if item.status == .completed {
                openFile(item)
            } else {
                openWindow(value: item.id)
            }
        }
        .onTapGesture {
            let index = sortedItems.firstIndex(where: { $0.id == item.id })
            
            if NSEvent.modifierFlags.contains(.command) {
                if selection.contains(item.id) {
                    selection.remove(item.id)
                } else {
                    selection.insert(item.id)
                }
                lastSelectedIndex = index
            } else if NSEvent.modifierFlags.contains(.shift), let lastIndex = lastSelectedIndex, let currentIndex = index {
                let range = min(lastIndex, currentIndex)...max(lastIndex, currentIndex)
                let rangeIds = range.map { sortedItems[$0].id }
                selection.formUnion(rangeIds)
            } else {
                selection = [item.id]
                lastSelectedIndex = index
            }
        }
        .contextMenu {
            rowContextMenu(for: item)
        }
        .onDrag {
            draggedItemID = item.id
            return NSItemProvider(object: dragPayload(for: item) as NSString)
        }
        .onDrop(
            of: [.text],
            delegate: QueueDropDelegate(
                item: item,
                queueID: queueID,
                draggedItemID: $draggedItemID,
                controller: controller
            )
        )
    }

    private func tableHeader(trailingWidth: CGFloat) -> some View {
        HStack(spacing: 0) {
            ForEach(orderedVisibleColumns) { column in
                ZStack(alignment: .trailing) {
                    headerContent(for: column)

                    Rectangle()
                        .fill(.secondary.opacity(0.18))
                        .frame(width: 1, height: 20)
                        .frame(width: 8, height: 34)
                        .contentShape(Rectangle())
                        .onHover { isHovering in
                            if isHovering {
                                NSCursor.resizeLeftRight.push()
                            } else {
                                NSCursor.pop()
                            }
                        }
                        .gesture(
                            DragGesture(minimumDistance: 1)
                                .onChanged { value in
                                    let baseWidth = resizeBaseWidths[column] ?? width(for: column)
                                    resizeBaseWidths[column] = baseWidth
                                    tableSettings.columnWidths[column] = max(70, baseWidth + value.translation.width)
                                }
                                .onEnded { _ in
                                    resizeBaseWidths[column] = nil
                                }
                        )
                }
                .frame(width: width(for: column), height: 34)
                .clipped()
            }

            if trailingWidth > 0 {
                Color.clear
                    .frame(width: trailingWidth, height: 34)
            }
        }
        .background(.bar)
        .contextMenu {
            Section("Columns") {
                ForEach(availableColumns) { column in
                    Toggle(column.rawValue, isOn: Binding(
                        get: { tableSettings.visibleColumns.contains(column) },
                        set: { isVisible in
                            if isVisible {
                                tableSettings.visibleColumns.insert(column)
                            } else if tableSettings.visibleColumns.count > 1 {
                                tableSettings.visibleColumns.remove(column)
                            }
                        }
                    ))
                }
            }
            if queueID == nil {
                Section("Sort By") {
                    ForEach(availableColumns) { column in
                        Button(column.rawValue) {
                            tableSettings.sortColumn = column
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func rowContextMenu(for item: DownloadItem) -> some View {
        let targetItems = selection.contains(item.id) ? controller.downloads.filter { selection.contains($0.id) } : [item]

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
            pendingDeleteItems = Set(targetItems.map(\.id))
        } label: {
            Label("Remove", systemImage: "trash")
        }
    }

    private var orderedVisibleColumns: [DownloadColumn] {
        var columns = DownloadColumn.allCases.filter { tableSettings.visibleColumns.contains($0) }
        if queueID != nil, !columns.contains(.priority) {
            columns.insert(.priority, at: 0)
        } else if queueID == nil {
            columns.removeAll { $0 == .priority }
        }
        return columns
    }

    private var availableColumns: [DownloadColumn] {
        DownloadColumn.allCases.filter { $0 != .priority }
    }

    private var totalWidth: CGFloat {
        orderedVisibleColumns.map { width(for: $0) }.reduce(0, +)
    }

    private func width(for column: DownloadColumn) -> CGFloat {
        max(70, tableSettings.columnWidths[column] ?? column.width)
    }

    private var sortedItems: [DownloadItem] {
        if queueID != nil {
            return items
        }

        return items.sorted { lhs, rhs in
            let result = compare(lhs, rhs, by: tableSettings.sortColumn)
            if result == .orderedSame {
                return lhs.id.uuidString < rhs.id.uuidString
            }
            return tableSettings.sortDirection == .ascending ? result == .orderedAscending : result == .orderedDescending
        }
    }

    private func compare(_ lhs: DownloadItem, _ rhs: DownloadItem, by column: DownloadColumn) -> ComparisonResult {
        switch column {
        case .priority:
            return compare(priorityNumber(for: lhs) ?? 0, priorityNumber(for: rhs) ?? 0)
        case .fileName: return lhs.fileName.localizedCaseInsensitiveCompare(rhs.fileName)
        case .size: return compare(lhs.sizeBytes ?? -1, rhs.sizeBytes ?? -1)
        case .status: return compare(lhs.status.rawValue, rhs.status.rawValue)
        case .progress: return compare(lhs.progress, rhs.progress)
        case .lastTry: return compare(lhs.lastTryAt ?? .distantPast, rhs.lastTryAt ?? .distantPast)
        case .dateAdded: return compare(lhs.createdAt, rhs.createdAt)
        case .category: return compare(lhs.category.rawValue, rhs.category.rawValue)
        case .connections: return compare(lhs.connectionsPerServer, rhs.connectionsPerServer)
        case .liveConnections: return compare(lhs.connectionCount, rhs.connectionCount)
        case .speed: return compare(lhs.speedText, rhs.speedText)
        case .eta: return compare(lhs.etaText, rhs.etaText)
        case .destination: return compare(lhs.destinationPath, rhs.destinationPath)
        case .url: return compare(lhs.url.absoluteString, rhs.url.absoluteString)
        case .message: return compare(lhs.message, rhs.message)
        }
    }

    @ViewBuilder
    private func headerContent(for column: DownloadColumn) -> some View {
        let content = HStack(spacing: 4) {
            Spacer(minLength: 0)
            Text(column.rawValue)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .truncationMode(.tail)
                .multilineTextAlignment(.center)
                .layoutPriority(1)
            if queueID == nil && tableSettings.sortColumn == column {
                Image(systemName: tableSettings.sortDirection == .ascending ? "chevron.up" : "chevron.down")
                    .font(.caption2)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .frame(width: width(for: column), height: 34, alignment: .center)
        .clipped()

        if queueID == nil {
            Button {
                if tableSettings.sortColumn == column {
                    tableSettings.sortDirection.toggle()
                } else {
                    tableSettings.sortColumn = column
                    tableSettings.sortDirection = .ascending
                }
            } label: {
                content
            }
            .buttonStyle(.plain)
        } else {
            content
        }
    }

    private func priorityNumber(for item: DownloadItem) -> Int? {
        guard queueID != nil,
              let index = items.firstIndex(where: { $0.id == item.id }) else {
            return nil
        }
        return index + 1
    }

    private func dragPayload(for item: DownloadItem) -> String {
        let draggedIDs = selection.contains(item.id) ? selection : [item.id]
        return draggedIDs
            .map(\.uuidString)
            .joined(separator: "\n")
    }

    private func compare<T: Comparable>(_ lhs: T, _ rhs: T) -> ComparisonResult {
        if lhs < rhs { return .orderedAscending }
        if lhs > rhs { return .orderedDescending }
        return .orderedSame
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

private struct DownloadRow: View {
    @EnvironmentObject private var settings: AppSettings
    let item: DownloadItem
    let priorityNumber: Int?
    let visibleColumns: [DownloadColumn]
    let columnWidth: (DownloadColumn) -> CGFloat
    let trailingWidth: CGFloat

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(visibleColumns) { column in
                cell(for: column)
                    .padding(.horizontal, 8)
                    .padding(.vertical, settings.listRowDensity.verticalPadding)
                    .frame(width: columnWidth(column), alignment: alignment(for: column))
                    .clipped()
            }

            if trailingWidth > 0 {
                Color.clear
                    .frame(width: trailingWidth)
            }
        }
    }

    @ViewBuilder
    private func cell(for column: DownloadColumn) -> some View {
        switch column {
        case .priority:
            Text(priorityNumber.map(String.init) ?? "-")
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .lineLimit(1)
        case .fileName:
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: item.category.symbolName)
                    .font(.title3)
                    .foregroundStyle(categoryColor)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 6) {
                    Text(item.fileName)
                        .font(.headline)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        case .size:
            Text(ByteFormatter.string(item.sizeBytes))
                .monospacedDigit()
                .lineLimit(1)
                .truncationMode(.tail)
        case .status, .progress:
            progressBarCell()
        case .lastTry:
            Text(formatted(item.lastTryAt))
                .lineLimit(1)
                .truncationMode(.tail)
        case .dateAdded:
            Text(formatted(item.createdAt))
                .lineLimit(1)
                .truncationMode(.tail)
        case .category:
            Text(item.category.rawValue)
                .lineLimit(1)
                .truncationMode(.tail)
        case .connections:
            Text("\(item.connectionsPerServer)")
                .monospacedDigit()
                .lineLimit(1)
        case .liveConnections:
            Text("\(item.connectionCount)")
                .monospacedDigit()
                .lineLimit(1)
        case .speed:
            Text(item.speedText)
                .lineLimit(1)
                .truncationMode(.tail)
        case .eta:
            Text(item.etaText)
                .lineLimit(1)
                .truncationMode(.tail)
        case .destination:
            Text(item.destinationPath)
                .font(.system(.caption, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.tail)
        case .url:
            Text(item.url.absoluteString)
                .font(.system(.caption, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.tail)
        case .message:
            Text(item.message)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
    }

    private func alignment(for column: DownloadColumn) -> Alignment {
        column == .fileName ? .leading : .center
    }

    private var categoryColor: Color {
        switch item.category {
        case .musics: return .pink
        case .movies: return .indigo
        case .compressed: return .orange
        case .pictures: return .teal
        case .documents: return .blue
        case .other: return .gray
        }
    }

    private var statusColor: Color {
        switch item.status {
        case .queued: return .secondary
        case .downloading: return .blue
        case .paused: return .orange
        case .completed: return .green
        case .failed: return .red
        case .canceled: return .gray
        }
    }

    @ViewBuilder
    private func progressBarCell() -> some View {
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
                        .fill(statusColor)
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
}

private struct QueueDropDelegate: DropDelegate {
    let item: DownloadItem
    let queueID: UUID?
    @Binding var draggedItemID: DownloadItem.ID?
    let controller: DownloadController

    func dropEntered(info: DropInfo) {
        guard let queueID,
              let draggedItemID,
              draggedItemID != item.id else {
            return
        }

        controller.moveDownload(draggedItemID, before: item.id, in: queueID)
    }

    func performDrop(info: DropInfo) -> Bool {
        draggedItemID = nil
        return queueID != nil
    }
}
