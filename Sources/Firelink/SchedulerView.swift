import SwiftUI

struct SchedulerView: View {
    @EnvironmentObject private var downloadController: DownloadController
    @EnvironmentObject private var schedulerController: SchedulerController
    @State private var showSaveToast: Bool = false
    
    // Local state to hold edits before saving
    @State private var isEnabled: Bool = false
    @State private var startTime: Date = Date()
    @State private var isEveryday: Bool = true
    @State private var selectedDays: Set<SchedulerDay> = []
    @State private var postQueueAction: PostQueueAction = .doNothing
    @State private var targetQueueIDs: Set<UUID> = []
    
    var body: some View {
        VStack(spacing: 0) {
            headerView
            Divider()
            
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 24) {
                        timeSelectionSection
                        queueSelectionSection
                        postActionSection
                    }
                    .opacity(isEnabled ? 1.0 : 0.5)
                    .disabled(!isEnabled)
                    
                    Divider()
                    permissionsSection
                }
                .padding(24)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear {
            loadState()
            schedulerController.checkAutomationPermission()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            schedulerController.checkAutomationPermission()
        }
        .overlay {
            if showSaveToast {
                toastView
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
    }
    
    private var headerView: some View {
        HStack {
            Toggle(isOn: $isEnabled) {
                Text("Scheduler")
                    .font(.title2.weight(.bold))
            }
            .toggleStyle(.switch)
            
            Spacer()
            
            Button("Save Settings") {
                saveState()
                withAnimation(.spring()) {
                    showSaveToast = true
                }
                
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                    withAnimation {
                        showSaveToast = false
                    }
                }
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(24)
    }
    
    private var timeSelectionSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Start Time")
                .font(.headline)
            
            DatePicker("Time", selection: $startTime, displayedComponents: [.hourAndMinute])
                .datePickerStyle(.stepperField)
                .labelsHidden()
            
            Toggle("Everyday", isOn: $isEveryday)
            
            if !isEveryday {
                HStack(spacing: 12) {
                    ForEach(SchedulerDay.allCases) { day in
                        Toggle(day.shortName, isOn: Binding(
                            get: { selectedDays.contains(day) },
                            set: { isSelected in
                                if isSelected {
                                    selectedDays.insert(day)
                                } else {
                                    selectedDays.remove(day)
                                }
                            }
                        ))
                        .toggleStyle(.button)
                    }
                }
            }
        }
    }
    
    private var queueSelectionSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Queues to Start")
                .font(.headline)
            
            if downloadController.queues.isEmpty {
                Text("No queues available")
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(downloadController.queues) { queue in
                        Toggle(queue.name, isOn: Binding(
                            get: { targetQueueIDs.contains(queue.id) },
                            set: { isSelected in
                                if isSelected {
                                    targetQueueIDs.insert(queue.id)
                                } else {
                                    targetQueueIDs.remove(queue.id)
                                }
                            }
                        ))
                    }
                }
            }
        }
    }
    
    private var postActionSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("After Completion")
                .font(.headline)
            
            Picker("Action", selection: $postQueueAction) {
                ForEach(PostQueueAction.allCases) { action in
                    Text(action.rawValue).tag(action)
                }
            }
            .labelsHidden()
            .pickerStyle(.radioGroup)
        }
    }
    
    private var permissionsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("System Permissions")
                .font(.headline)
            
            Text("Firelink needs Automation permission to control Finder in order to automatically sleep, restart, or shut down your Mac after downloads finish.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            
            if schedulerController.hasAutomationPermission {
                Button("Revoke Permissions") {
                    schedulerController.openAutomationPermissionSettings()
                }
                .buttonStyle(.bordered)
            } else {
                Button("Grant Permission") {
                    schedulerController.requestAutomationPermission()
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }
    
    private var toastView: some View {
        VStack {
            Spacer()
            HStack(spacing: 10) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundColor(.green)
                Text("Settings Saved")
                    .fontWeight(.medium)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.regularMaterial)
            .clipShape(Capsule())
            .shadow(radius: 4, y: 2)
            .padding(.bottom, 30)
        }
        .allowsHitTesting(false)
    }
    
    private func loadState() {
        isEnabled = schedulerController.settings.isEnabled
        startTime = schedulerController.settings.startTime
        isEveryday = schedulerController.settings.isEveryday
        selectedDays = schedulerController.settings.selectedDays
        postQueueAction = schedulerController.settings.postQueueAction
        targetQueueIDs = schedulerController.settings.targetQueueIDs
    }
    
    private func saveState() {
        schedulerController.settings.isEnabled = isEnabled
        schedulerController.settings.startTime = startTime
        schedulerController.settings.isEveryday = isEveryday
        schedulerController.settings.selectedDays = selectedDays
        schedulerController.settings.postQueueAction = postQueueAction
        schedulerController.settings.targetQueueIDs = targetQueueIDs
        schedulerController.saveSettings()
    }
}
