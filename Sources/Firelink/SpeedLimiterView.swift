import SwiftUI

struct SpeedLimiterView: View {
    @EnvironmentObject private var settings: AppSettings
    @State private var showSaveToast: Bool = false
    
    // Local state to hold edits before saving
    @State private var isEnabled: Bool = false
    @State private var speedLimitKiBPerSecond: Int = 1024
    
    var body: some View {
        VStack(spacing: 0) {
            headerView
            Divider()
            
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    limitSelectionSection
                        .opacity(isEnabled ? 1.0 : 0.5)
                        .disabled(!isEnabled)
                }
                .padding(24)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear {
            loadState()
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
                Text("Speed Limiter")
                    .font(.title2.weight(.bold))
            }
            .toggleStyle(.switch)
            
            Spacer()
            
            Button("Save Limit") {
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
    
    private var limitSelectionSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Global Speed Limit")
                .font(.headline)
            
            Text("This limit applies globally to all active downloads. Individual downloads can also have their own specific limits defined in their properties.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            
            HStack {
                Stepper(value: $speedLimitKiBPerSecond, in: 1...10_485_760, step: 512) {
                    Text("Maximum Speed:")
                }
                
                TextField("Speed", value: $speedLimitKiBPerSecond, format: .number)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 80)
                
                Text("KiB/s")
                    .foregroundStyle(.secondary)
            }
            
            // Helpful presets
            HStack(spacing: 12) {
                Button("1 MB/s") { speedLimitKiBPerSecond = 1024 }
                Button("5 MB/s") { speedLimitKiBPerSecond = 5120 }
                Button("10 MB/s") { speedLimitKiBPerSecond = 10240 }
            }
            .buttonStyle(.bordered)
            .padding(.top, 8)
        }
    }
    
    private var toastView: some View {
        VStack {
            Spacer()
            HStack(spacing: 10) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundColor(.green)
                Text("Speed Limit Saved")
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
    
    @AppStorage("lastCustomSpeedLimit") private var lastCustomSpeedLimit: Int = 1024
    
    private func loadState() {
        let currentLimit = settings.globalSpeedLimitKiBPerSecond
        isEnabled = currentLimit > 0
        speedLimitKiBPerSecond = currentLimit > 0 ? currentLimit : lastCustomSpeedLimit
    }
    
    private func saveState() {
        // Clamp to ensure it doesn't break aria2
        let clampedSpeed = max(min(speedLimitKiBPerSecond, 10_485_760), 1)
        speedLimitKiBPerSecond = clampedSpeed
        
        lastCustomSpeedLimit = clampedSpeed
        settings.globalSpeedLimitKiBPerSecond = isEnabled ? clampedSpeed : 0
    }
}
