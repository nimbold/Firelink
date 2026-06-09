import AppKit
import SwiftUI

struct IntegrationSettingsPane: View {
    @EnvironmentObject private var controller: DownloadController
    @EnvironmentObject private var settings: AppSettings
    @State private var showToast = false

    var body: some View {
        VStack(spacing: 20) {
            // Header
            HStack(alignment: .center, spacing: 16) {
                Image(systemName: "puzzlepiece.extension.fill")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 40, height: 40)
                    .foregroundStyle(Color(nsColor: NSColor(red: 1.0, green: 0.44, blue: 0.22, alpha: 1.0)))
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 4) {
                    Text("Connect Browser Extension")
                        .font(.title2.weight(.bold))
                    Text("Capture downloads directly from your browser in three easy steps.")
                        .foregroundStyle(.secondary)
                        .font(.subheadline)
                }
                Spacer()
            }

            KeychainAccessCard()

            if settings.isKeychainAccessGranted {
                HStack(spacing: 12) {
                    // Step 1
                    CompactStepCardView(
                        stepNumber: 1,
                        title: "Copy Token",
                        description: "This secure token authorizes your browser extension.",
                        icon: "doc.on.clipboard.fill",
                        iconColor: .blue,
                        actionText: "Copy Token",
                        action: {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(settings.extensionPairingToken, forType: .string)
                            withAnimation {
                                showToast = true
                            }
                        },
                        secondaryActionText: "Regenerate",
                        secondaryAction: {
                            var bytes = [UInt8](repeating: 0, count: 32)
                            let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
                            settings.extensionPairingToken = status == errSecSuccess ? Data(bytes).base64EncodedString() : UUID().uuidString
                        }
                    )

                    Image(systemName: "chevron.right")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(Color(nsColor: .tertiaryLabelColor))

                    // Step 2
                    CompactStepCardView(
                        stepNumber: 2,
                        title: "Get Extension",
                        description: "Install the Firelink Companion extension on your browser.",
                        icon: "globe",
                        iconColor: .orange,
                        actionText: "Firefox Add-ons",
                        action: {
                            if let url = URL(string: "https://addons.mozilla.org/en-US/firefox/addon/firelink-companion/") {
                                NSWorkspace.shared.open(url)
                            }
                        },
                        secondaryActionText: "Releases",
                        secondaryAction: {
                            if let url = URL(string: "https://github.com/nimbold/Firelink-Extension/releases") {
                                NSWorkspace.shared.open(url)
                            }
                        }
                    )

                    Image(systemName: "chevron.right")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(Color(nsColor: .tertiaryLabelColor))

                    // Step 3
                    CompactStepCardView(
                        stepNumber: 3,
                        title: "Paste & Connect",
                        description: "Click the Firelink icon in your browser's toolbar and paste the token.",
                        icon: "arrow.down.doc.fill",
                        iconColor: .green,
                        actionText: nil,
                        action: nil
                    )
                }
                .fixedSize(horizontal: false, vertical: true)
                
                Divider()
                
                // Diagnostics
                HStack {
                    Text("Diagnostics:")
                        .foregroundStyle(.secondary)
                    Spacer()
                    if let port = controller.extensionServerPort {
                        Label("Listening on 127.0.0.1:\(port)", systemImage: "checkmark.seal.fill")
                            .foregroundStyle(.green)
                    } else {
                        Label("Not listening", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }
                .font(.footnote)
            }
            Spacer()
        }
        .padding(24)
        .toast(isShowing: $showToast, message: "Token copied to clipboard!")
        .background(Color(NSColor.windowBackgroundColor))
    }
}

struct CompactStepCardView: View {
    let stepNumber: Int
    let title: String
    let description: String
    let icon: String
    let iconColor: Color
    let actionText: String?
    let action: (() -> Void)?
    var secondaryActionText: String? = nil
    var secondaryAction: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 12) {
            HStack(alignment: .top) {
                // Step Number Badge
                ZStack {
                    Circle()
                        .fill(Color(nsColor: .controlBackgroundColor))
                        .frame(width: 24, height: 24)
                        .shadow(color: .black.opacity(0.1), radius: 1, y: 1)
                    
                    Text("\(stepNumber)")
                        .font(.system(.caption, design: .rounded).weight(.bold))
                        .foregroundStyle(.primary)
                }
                Spacer()
                // Icon
                ZStack {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(iconColor.opacity(0.15))
                        .frame(width: 32, height: 32)
                    
                    Image(systemName: icon)
                        .font(.system(size: 16))
                        .foregroundStyle(iconColor)
                }
            }
            
            // Text Content
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            
            Spacer(minLength: 8)
            
            // Action Button
            VStack(spacing: 8) {
                if let actionText = actionText, let action = action {
                    Button(action: action) {
                        Text(actionText)
                            .font(.caption.weight(.medium))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                            .background(Color.accentColor)
                            .foregroundColor(.white)
                            .cornerRadius(6)
                    }
                    .buttonStyle(.plain)
                }
                
                if let secondaryActionText = secondaryActionText, let secondaryAction = secondaryAction {
                    Button(action: secondaryAction) {
                        Text(secondaryActionText)
                            .font(.caption.weight(.medium))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                            .background(Color(nsColor: .controlBackgroundColor))
                            .foregroundColor(.primary)
                            .cornerRadius(6)
                            .overlay(
                                RoundedRectangle(cornerRadius: 6)
                                    .strokeBorder(Color(nsColor: .separatorColor).opacity(0.5), lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
