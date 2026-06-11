import Foundation
import Darwin

enum ProcessTreeTerminator {
    static func terminate(_ process: Process, forceAfter delay: TimeInterval = 0.5) {
        let rootPID = process.processIdentifier
        guard rootPID > 0 else { return }

        let processIDs = descendants(of: rootPID) + [rootPID]
        signal(processIDs.reversed(), with: SIGTERM)

        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + delay) {
            signal(processIDs.reversed(), with: SIGKILL)
        }
    }

    private static func descendants(of rootPID: pid_t) -> [pid_t] {
        var result: [pid_t] = []
        var pending = directChildren(of: rootPID)

        while let processID = pending.popLast() {
            result.append(processID)
            pending.append(contentsOf: directChildren(of: processID))
        }

        return result
    }

    private static func directChildren(of processID: pid_t) -> [pid_t] {
        var capacity = 32

        while capacity <= 4096 {
            var processIDs = [pid_t](repeating: 0, count: capacity)
            let count = processIDs.withUnsafeMutableBytes { buffer in
                proc_listchildpids(processID, buffer.baseAddress, Int32(buffer.count))
            }

            guard count > 0 else { return [] }
            if count < capacity {
                return Array(processIDs.prefix(Int(count))).filter { $0 > 0 }
            }
            capacity *= 2
        }

        return []
    }

    private static func signal<S: Sequence>(_ processIDs: S, with signal: Int32) where S.Element == pid_t {
        for processID in processIDs where processID > 0 {
            kill(processID, signal)
        }
    }
}
