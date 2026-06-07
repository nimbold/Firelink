with open("Sources/Firelink/FirelinkApp.swift", "r") as f:
    app_content = f.read()

old_group = '''        WindowGroup("Download Properties", id: "download-properties", for: UUID.self) { $downloadID in
            if let downloadID {'''
new_group = '''        WindowGroup("Download Properties", id: "download-properties", for: String.self) { $downloadIDString in
            if let idString = downloadIDString, let downloadID = UUID(uuidString: idString) {'''
app_content = app_content.replace(old_group, new_group)

with open("Sources/Firelink/FirelinkApp.swift", "w") as f:
    f.write(app_content)

with open("Sources/Firelink/DownloadTable.swift", "r") as f:
    table_content = f.read()

old_open1 = 'openWindow(id: "download-properties", value: item.id)'
new_open1 = 'openWindow(id: "download-properties", value: item.id.uuidString)'
table_content = table_content.replace(old_open1, new_open1)

with open("Sources/Firelink/DownloadTable.swift", "w") as f:
    f.write(table_content)
