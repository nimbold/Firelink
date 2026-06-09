import SwiftUI

struct KeychainAccessCard: View {
    @EnvironmentObject private var settings: AppSettings
    
    var body: some View {
        HStack(spacing: 16) {
            ZStack {
                RoundedRectangle(cornerRadius: 10)
                    .fill(settings.isKeychainAccessGranted ? Color.green.opacity(0.15) : Color.blue.opacity(0.15))
                    .frame(width: 36, height: 36)
                
                Image(systemName: settings.isKeychainAccessGranted ? "lock.open.fill" : "lock.fill")
                    .font(.system(size: 18))
                    .foregroundStyle(settings.isKeychainAccessGranted ? .green : .blue)
            }
            
            VStack(alignment: .leading, spacing: 2) {
                Text("Keychain Access")
                    .font(.headline)
                Text("Firelink needs Keychain access to securely store your browser extension pairing token.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            
            Spacer(minLength: 16)
            
            if settings.isKeychainAccessGranted {
                Label("Granted", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.subheadline.weight(.medium))
                
                Button(role: .destructive) {
                    settings.revokeKeychainAccess()
                } label: {
                    Text("Revoke")
                }
            } else {
                Button {
                    settings.grantKeychainAccess()
                } label: {
                    Text("Grant Access")
                        .font(.subheadline.weight(.medium))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Color.accentColor)
                        .foregroundColor(.white)
                        .cornerRadius(6)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color(nsColor: .controlBackgroundColor))
                .shadow(color: .black.opacity(0.05), radius: 4, y: 1)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color(nsColor: .separatorColor).opacity(0.5), lineWidth: 1)
        )
    }
}
