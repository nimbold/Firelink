import AppKit
import Combine
import Foundation

enum PostQueueAction: String, Codable, CaseIterable, Identifiable {
    case doNothing = "Do nothing"
    case sleep = "Sleep"
    case restart = "Restart"
    case shutdown = "Shut down"

    var id: String { rawValue }
}

enum SchedulerDay: Int, Codable, CaseIterable, Identifiable {
    case sunday = 1, monday, tuesday, wednesday, thursday, friday, saturday

    var id: Int { rawValue }

    var shortName: String {
        switch self {
        case .sunday: "Su"
        case .monday: "Mo"
        case .tuesday: "Tu"
        case .wednesday: "We"
        case .thursday: "Th"
        case .friday: "Fr"
        case .saturday: "Sa"
        }
    }
}

struct SchedulerSettings: Codable, Equatable {
    var isEnabled: Bool = false
    var startTime: Date = Calendar.current.date(bySettingHour: 0, minute: 0, second: 0, of: Date()) ?? Date()
    var stopTimeEnabled: Bool = false
    var stopTime: Date = Calendar.current.date(bySettingHour: 8, minute: 0, second: 0, of: Date()) ?? Date()
    var isEveryday: Bool = true
    var selectedDays: Set<SchedulerDay> = Set(SchedulerDay.allCases)
    var postQueueAction: PostQueueAction = .doNothing
    var targetQueueIDs: Set<UUID> = [DownloadQueue.mainQueueID]
}

@MainActor
final class SchedulerController: ObservableObject {
    @Published var settings: SchedulerSettings
    @Published var isRunning: Bool = false
    @Published var hasAutomationPermission: Bool = false
    private let downloadController: DownloadController
    private var cancellables = Set<AnyCancellable>()
    private var timer: Timer?

    private let defaults = UserDefaults.standard
    private let storageKey = "Firelink.SchedulerSettings.v1"

    // We only trigger once per minute to prevent multiple triggers in the same minute
    private var lastTriggeredMinute: Date?

    init(downloadController: DownloadController) {
        self.downloadController = downloadController

        if let data = defaults.data(forKey: "Firelink.SchedulerSettings.v1"),
           let stored = try? JSONDecoder().decode(SchedulerSettings.self, from: data) {
            self.settings = stored
        } else {
            self.settings = SchedulerSettings()
        }
        if self.settings.targetQueueIDs.isEmpty {
            self.settings.targetQueueIDs = [DownloadQueue.mainQueueID]
        }

        checkAutomationPermission()
        startTimer()

        $settings
            .dropFirst()
            .sink { _ in
                // We do NOT save instantly here to UserDefaults because the UI will have a "Save" button
            }
            .store(in: &cancellables)

        // Observe downloads to check if we should trigger post-action
        downloadController.$downloads
            .dropFirst()
            .sink { [weak self] _ in
                self?.checkIfRunningFinished()
            }
            .store(in: &cancellables)
    }

    func saveSettings() {
        if let data = try? JSONEncoder().encode(settings) {
            defaults.set(data, forKey: storageKey)
        }
    }

    private func startTimer() {
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.checkSchedule()
            }
        }
    }

    private func checkSchedule() {
        guard settings.isEnabled else { return }

        let now = Date()
        let calendar = Calendar.current

        // Check if we already triggered in this exact minute
        if let last = lastTriggeredMinute, calendar.isDate(last, equalTo: now, toGranularity: .minute) {
            return
        }

        let startHour = calendar.component(.hour, from: settings.startTime)
        let startMinute = calendar.component(.minute, from: settings.startTime)

        let currentHour = calendar.component(.hour, from: now)
        let currentMinute = calendar.component(.minute, from: now)
        let currentWeekday = calendar.component(.weekday, from: now)

        let shouldRunToday: Bool
        if settings.isEveryday {
            shouldRunToday = true
        } else {
            let day = SchedulerDay(rawValue: currentWeekday)
            shouldRunToday = day.map { settings.selectedDays.contains($0) } ?? false
        }

        if shouldRunToday {
            if startHour == currentHour && startMinute == currentMinute {
                lastTriggeredMinute = now
                triggerQueues()
            }
            
            if settings.stopTimeEnabled {
                let stopHour = calendar.component(.hour, from: settings.stopTime)
                let stopMinute = calendar.component(.minute, from: settings.stopTime)
                
                if stopHour == currentHour && stopMinute == currentMinute {
                    lastTriggeredMinute = now
                    pauseQueues()
                }
            }
        }
    }

    private func pauseQueues() {
        let targetQueueIDs = effectiveTargetQueueIDs()
        for queueID in targetQueueIDs {
            downloadController.pauseActiveDownloads(queueID: queueID)
        }
    }

    private func triggerQueues() {
        let targetQueueIDs = effectiveTargetQueueIDs()
        let runnableQueueIDs = targetQueueIDs.filter { queueID in
            downloadController.queues.contains(where: { $0.id == queueID }) &&
                downloadController.queueItems(for: queueID).contains(where: { $0.status == .queued })
        }

        guard !runnableQueueIDs.isEmpty else { return }

        isRunning = true

        for queueID in runnableQueueIDs {
            downloadController.startQueue(queueID: queueID)
        }

        checkIfRunningFinished()
    }

    private func checkIfRunningFinished() {
        guard isRunning else { return }

        let targetQueueIDs = effectiveTargetQueueIDs()
        let hasActiveItems = targetQueueIDs.contains { queueID in
            downloadController.queueItems(for: queueID).contains {
                $0.status == .queued || $0.status == .downloading
            }
        }

        if !hasActiveItems {
            isRunning = false
            performPostAction()
        }
    }

    private func effectiveTargetQueueIDs() -> Set<UUID> {
        settings.targetQueueIDs.isEmpty ? [DownloadQueue.mainQueueID] : settings.targetQueueIDs
    }

    private func performPostAction() {
        guard settings.postQueueAction != .doNothing else { return }

        var scriptCode = ""
        switch settings.postQueueAction {
        case .sleep:
            scriptCode = "tell application \"Finder\" to sleep"
        case .restart:
            scriptCode = "tell application \"Finder\" to restart"
        case .shutdown:
            scriptCode = "tell application \"Finder\" to shut down"
        case .doNothing:
            break
        }

        guard !scriptCode.isEmpty else { return }

        var error: NSDictionary?
        if let script = NSAppleScript(source: scriptCode) {
            script.executeAndReturnError(&error)
            if let error {
                print("Failed to perform scheduler post action: \(error)")
            }
        }
    }

    func checkAutomationPermission() {
        let target = NSAppleEventDescriptor(bundleIdentifier: "com.apple.finder")
        let status = AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, false)
        hasAutomationPermission = (status == noErr)
    }

    func requestAutomationPermission() {
        let target = NSAppleEventDescriptor(bundleIdentifier: "com.apple.finder")
        let status = AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, true)

        if status != noErr {
            triggerAutomationConsentPrompt()
        }

        checkAutomationPermission()

        if !hasAutomationPermission {
            openAutomationPermissionSettings()
        }
    }

    func openAutomationPermissionSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation") else {
            return
        }

        NSWorkspace.shared.open(url)
    }

    private func triggerAutomationConsentPrompt() {
        let scriptCode = "tell application \"Finder\" to get name"

        var error: NSDictionary?
        if let script = NSAppleScript(source: scriptCode) {
            script.executeAndReturnError(&error)
            if let error {
                print("Failed to trigger Automation permission prompt: \(error)")
            }
        }
    }
}
