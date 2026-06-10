import AppKit
import SwiftUI

struct LocationsSettingsPane: View {
    @EnvironmentObject private var settings: AppSettings

    var body: some View {
        Form {
            Section(footer: Text("When enabled, you can choose the download location each time you add a download. Otherwise, files are saved automatically.")) {
                Toggle("Ask where to save each file before downloading", isOn: $settings.askWhereToSaveEachFile)
            }
            
            Section(footer: Text("Folders will be created automatically when saving.")) {
                BulkDirectoryPickerRow()
                
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
        .formStyle(.grouped)
    }
}

struct DirectoryPickerRow: View {
    @EnvironmentObject private var settings: AppSettings
    let category: DownloadCategory

    @State private var path = ""
    @State private var message = ""

    var body: some View {
        LabeledContent {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    TextField("Folder path", text: $path, prompt: Text("Folder path"))
                        .labelsHidden()
                        .textFieldStyle(.roundedBorder)
                        .multilineTextAlignment(.leading)
                        .font(.system(.body, design: .monospaced))
                        .onSubmit {
                            applyPath()
                        }

                    Button("Choose...") {
                        selectFolder()
                    }
                }

                if let displayMessage = message.isEmpty ? statusMessage(for: path) : message, !displayMessage.isEmpty {
                    Text(displayMessage)
                        .font(.caption)
                        .foregroundStyle(isErrorMessage(displayMessage) ? .red : .secondary)
                }
            }
        } label: {
            Label(category.rawValue, systemImage: category.symbolName)
        }
        .onAppear {
            syncPathFromSettings()
        }
        .onChange(of: settings.downloadDirectories[category]) { _, _ in
            syncPathFromSettings()
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
            path = url.path
            settings.setDirectory(url.path, for: category)
            message = "Saved."
        }
    }

    private func syncPathFromSettings() {
        path = settings.downloadDirectories[category] ?? settings.destinationDirectory(for: category).path
        message = ""
    }

    private func applyPath() {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            message = "Enter a folder path."
            return
        }

        let expanded = NSString(string: trimmed).expandingTildeInPath
        var isDirectory: ObjCBool = false

        if FileManager.default.fileExists(atPath: expanded, isDirectory: &isDirectory) {
            guard isDirectory.boolValue else {
                message = "This path points to a file, not a folder."
                return
            }
        } else {
            do {
                try FileManager.default.createDirectory(
                    at: URL(fileURLWithPath: expanded, isDirectory: true),
                    withIntermediateDirectories: true
                )
            } catch {
                message = "Could not create folder: \(error.localizedDescription)"
                return
            }
        }

        guard FileManager.default.isWritableFile(atPath: expanded) else {
            message = "Firelink cannot write to this folder."
            return
        }

        settings.setDirectory(expanded, for: category)
        path = expanded
        message = "Saved."
    }

    private func statusMessage(for path: String) -> String? {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "Enter a folder path." }

        let expanded = NSString(string: trimmed).expandingTildeInPath
        var isDirectory: ObjCBool = false

        if FileManager.default.fileExists(atPath: expanded, isDirectory: &isDirectory) {
            if !isDirectory.boolValue {
                return "This path points to a file, not a folder."
            }
            return FileManager.default.isWritableFile(atPath: expanded)
                ? nil
                : "Firelink cannot write to this folder."
        }

        return nil
    }

    private func isErrorMessage(_ message: String) -> Bool {
        message == "This path points to a file, not a folder." ||
        message.hasPrefix("Could not create folder:") ||
        message == "Firelink cannot write to this folder." ||
        message == "Enter a folder path."
    }
}

struct BulkDirectoryPickerRow: View {
    @EnvironmentObject private var settings: AppSettings
    @State private var path = ""
    @State private var message = ""

    var body: some View {
        LabeledContent {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    TextField("Base folder path", text: $path, prompt: Text("Base folder path"))
                        .labelsHidden()
                        .textFieldStyle(.roundedBorder)
                        .multilineTextAlignment(.leading)
                        .font(.system(.body, design: .monospaced))
                        .onSubmit {
                            applyPath()
                        }

                    Button("Choose...") {
                        selectFolder()
                    }
                }

                if !message.isEmpty {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(isErrorMessage(message) ? .red : .secondary)
                }
            }
        } label: {
            Label("All Categories", systemImage: "folder.fill.badge.plus")
        }
    }

    private func selectFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true

        if panel.runModal() == .OK, let url = panel.url {
            path = url.path
            applyPath()
        }
    }

    private func applyPath() {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            message = "Enter a base folder path."
            return
        }

        let expanded = NSString(string: trimmed).expandingTildeInPath
        var isDirectory: ObjCBool = false

        if FileManager.default.fileExists(atPath: expanded, isDirectory: &isDirectory) {
            guard isDirectory.boolValue else {
                message = "This path points to a file, not a folder."
                return
            }
        } else {
            do {
                try FileManager.default.createDirectory(
                    at: URL(fileURLWithPath: expanded, isDirectory: true),
                    withIntermediateDirectories: true
                )
            } catch {
                message = "Could not create folder: \(error.localizedDescription)"
                return
            }
        }

        guard FileManager.default.isWritableFile(atPath: expanded) else {
            message = "Firelink cannot write to this folder."
            return
        }

        for category in DownloadCategory.allCases {
            let categoryPath = (expanded as NSString).appendingPathComponent(category.rawValue)
            do {
                try FileManager.default.createDirectory(
                    at: URL(fileURLWithPath: categoryPath, isDirectory: true),
                    withIntermediateDirectories: true
                )
                settings.setDirectory(categoryPath, for: category)
            } catch {
                message = "Could not create category folder \(category.rawValue): \(error.localizedDescription)"
                return
            }
        }

        message = "Created all categories in base folder."
        path = ""
    }

    private func isErrorMessage(_ message: String) -> Bool {
        message == "This path points to a file, not a folder." ||
        message.hasPrefix("Could not create folder:") ||
        message.hasPrefix("Could not create category folder") ||
        message == "Firelink cannot write to this folder." ||
        message == "Enter a base folder path."
    }
}
