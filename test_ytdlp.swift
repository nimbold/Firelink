import Foundation

struct RawMediaFormat: Decodable {
    let format_id: String?
}

struct MediaMetadata: Decodable {
    let id: String?
    let formats: [RawMediaFormat]?
}

let executableURL = URL(fileURLWithPath: "/Users/nima/Documents/Code/Firelink/Sources/Firelink/yt-dlp")
let arguments = [
    "-J", 
    "--no-warnings", 
    "--ignore-no-formats-error", 
    "--no-playlist", 
    "--force-ipv4",
    "https://www.youtube.com/watch?v=jNQXAC9IVRw"
]

let process = Process()
let outputPipe = Pipe()
let errorPipe = Pipe()

process.executableURL = executableURL
process.arguments = arguments
process.standardOutput = outputPipe
process.standardError = errorPipe

do {
    try process.run()
    process.waitUntilExit()
    
    let outputData = outputPipe.fileHandleForReading.readDataToEndOfFile()
    
    if process.terminationStatus == 0 {
        do {
            let metadata = try JSONDecoder().decode(MediaMetadata.self, from: outputData)
            print("Successfully decoded metadata with \(metadata.formats?.count ?? 0) formats")
        } catch {
            print("Decoding failed: \(error)")
        }
    } else {
        print("Failed! Exit code: \(process.terminationStatus)")
        print(String(data: errorPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "")
    }
} catch {
    print("Process run threw error: \(error.localizedDescription)")
}
