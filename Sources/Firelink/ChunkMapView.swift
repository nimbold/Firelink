import SwiftUI

struct ChunkMapView: View {
    let item: DownloadItem

    @State private var bitfield: String = ""
    @State private var numPieces: Int = 0
    @State private var pollTask: Task<Void, Never>?
    @State private var isVisible = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if numPieces > 0 {
                ChunkGrid(bitfield: bitfield, numPieces: numPieces)
            } else {
                Text("Loading chunk data...")
                    .foregroundStyle(.secondary)
                    .font(.caption)
            }
        }
        .onAppear {
            isVisible = true
            startPolling()
        }
        .onDisappear {
            isVisible = false
            pollTask?.cancel()
        }
        .onChange(of: item.status) { _, status in
            if status != .downloading {
                pollTask?.cancel()
            } else if isVisible && pollTask == nil {
                startPolling()
            }
        }
    }

    private func startPolling() {
        pollTask?.cancel()
        guard let port = item.rpcPort, let secret = item.rpcSecret, item.status == .downloading else { return }

        pollTask = Task {
            while !Task.isCancelled {
                await fetchStatus(port: port, secret: secret)
                do {
                    try await Task.sleep(nanoseconds: 1_000_000_000)
                } catch {
                    break
                }
            }
        }
    }

    private func fetchStatus(port: Int, secret: String) async {
        guard let url = URL(string: "http://127.0.0.1:\(port)/jsonrpc") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")

        let payload: [String: Any] = [
            "jsonrpc": "2.0",
            "method": "aria2.tellActive",
            "id": "1",
            "params": ["token:\(secret)", ["bitfield", "numPieces"]]
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        request.httpBody = data

        do {
            let (responseData, _) = try await URLSession.shared.data(for: request)
            guard let json = try JSONSerialization.jsonObject(with: responseData) as? [String: Any],
                  let result = json["result"] as? [[String: Any]],
                  let active = result.first else {
                return
            }

            let fetchedBitfield = active["bitfield"] as? String ?? ""
            let fetchedNumPiecesStr = active["numPieces"] as? String ?? "0"
            let fetchedNumPieces = Int(fetchedNumPiecesStr) ?? 0

            await MainActor.run {
                self.bitfield = fetchedBitfield
                self.numPieces = fetchedNumPieces
            }
        } catch {
            // Ignore errors
        }
    }
}

struct ChunkGrid: View {
    let bitfield: String
    let numPieces: Int

    private var pieces: [Bool] {
        var result = [Bool]()
        result.reserveCapacity(numPieces)
        for char in bitfield {
            if let val = char.hexDigitValue {
                for i in (0..<4).reversed() {
                    if result.count < numPieces {
                        result.append((val & (1 << i)) != 0)
                    }
                }
            }
        }
        while result.count < numPieces {
            result.append(false)
        }
        return result
    }

    var body: some View {
        let itemPieces = pieces
        Canvas { context, size in
            let boxSize: CGFloat = 10
            let spacing: CGFloat = 2
            let cornerSize = CGSize(width: 2, height: 2)
            let width = size.width

            let x: CGFloat = 0
            let y: CGFloat = 0

            let completedPath = Path { p in
                var cx = x
                var cy = y
                for piece in itemPieces {
                    if piece {
                        p.addRoundedRect(in: CGRect(x: cx, y: cy, width: boxSize - spacing, height: boxSize - spacing), cornerSize: cornerSize)
                    }
                    cx += boxSize
                    if cx + boxSize > width {
                        cx = 0
                        cy += boxSize
                    }
                }
            }

            let pendingPath = Path { p in
                var cx: CGFloat = 0
                var cy: CGFloat = 0
                for piece in itemPieces {
                    if !piece {
                        p.addRoundedRect(in: CGRect(x: cx, y: cy, width: boxSize - spacing, height: boxSize - spacing), cornerSize: cornerSize)
                    }
                    cx += boxSize
                    if cx + boxSize > width {
                        cx = 0
                        cy += boxSize
                    }
                }
            }

            context.fill(pendingPath, with: .color(Color.primary.opacity(0.08)))
            context.fill(completedPath, with: .color(Color.accentColor))
        }
        .frame(minHeight: 140)
    }
}
