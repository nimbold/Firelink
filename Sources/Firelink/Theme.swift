import SwiftUI
import AppKit

enum AppFontSize: String, Codable, CaseIterable, Identifiable, Sendable {
    case small = "Small"
    case standard = "Standard"
    case large = "Large"

    var id: String { rawValue }

    var dynamicTypeSize: DynamicTypeSize {
        switch self {
        case .small: return .xSmall
        case .standard: return .medium
        case .large: return .xxLarge
        }
    }

    var defaultFont: Font {
        switch self {
        case .small:
            return .system(size: 12)
        case .standard:
            return .system(size: 13)
        case .large:
            return .system(size: 15)
        }
    }

    var controlSize: ControlSize {
        switch self {
        case .small:
            return .small
        case .standard:
            return .regular
        case .large:
            return .large
        }
    }
}

enum ListRowDensity: String, Codable, CaseIterable, Identifiable, Sendable {
    case compact = "Compact"
    case standard = "Standard"
    case relaxed = "Relaxed"

    var id: String { rawValue }

    var verticalPadding: CGFloat {
        switch self {
        case .compact: return 4
        case .standard: return 8
        case .relaxed: return 14
        }
    }
}

enum AppTheme: String, Codable, CaseIterable, Identifiable, Sendable {
    case system = "System Default"
    case light = "Light"
    case dark = "Dark"
    case dracula = "Dracula"
    case nord = "Nord"

    var id: String { rawValue }

    var theme: Theme {
        switch self {
        case .system, .dark:
            return Theme.system
        case .light:
            return Theme.modernLight
        case .dracula:
            return Theme.dracula
        case .nord:
            return Theme.nord
        }
    }

    var appearance: NSAppearance? {
        switch self {
        case .system: return nil
        case .light: return NSAppearance(named: .aqua)
        case .dark, .dracula, .nord: return NSAppearance(named: .darkAqua)
        }
    }
}

struct Theme: Equatable, Sendable {
    var background: Color?
    var secondaryBackground: Color?
    var text: Color?
    var secondaryText: Color?
    var accent: Color?

    static let system = Theme(
        background: nil,
        secondaryBackground: nil,
        text: nil,
        secondaryText: nil,
        accent: nil
    )

    static let modernLight = Theme(
        background: Color(nsColor: NSColor(calibratedRed: 0.98, green: 0.98, blue: 0.99, alpha: 1.0)),
        secondaryBackground: Color(nsColor: NSColor(calibratedRed: 0.94, green: 0.94, blue: 0.96, alpha: 1.0)),
        text: Color.primary,
        secondaryText: Color.secondary,
        accent: Color.accentColor
    )

    static let dracula = Theme(
        background: Color(nsColor: NSColor(calibratedRed: 0.16, green: 0.16, blue: 0.21, alpha: 1.0)),
        secondaryBackground: Color(nsColor: NSColor(calibratedRed: 0.27, green: 0.28, blue: 0.35, alpha: 1.0)),
        text: Color(nsColor: NSColor(calibratedRed: 0.97, green: 0.97, blue: 0.95, alpha: 1.0)),
        secondaryText: Color(nsColor: NSColor(calibratedRed: 0.38, green: 0.44, blue: 0.58, alpha: 1.0)),
        accent: Color(nsColor: NSColor(calibratedRed: 1.00, green: 0.47, blue: 0.65, alpha: 1.0)) // Pink
    )

    static let nord = Theme(
        background: Color(nsColor: NSColor(calibratedRed: 0.18, green: 0.20, blue: 0.25, alpha: 1.0)), // nord0
        secondaryBackground: Color(nsColor: NSColor(calibratedRed: 0.23, green: 0.26, blue: 0.32, alpha: 1.0)), // nord1
        text: Color(nsColor: NSColor(calibratedRed: 0.85, green: 0.87, blue: 0.91, alpha: 1.0)), // nord4
        secondaryText: Color(nsColor: NSColor(calibratedRed: 0.57, green: 0.63, blue: 0.70, alpha: 1.0)), // nord3
        accent: Color(nsColor: NSColor(calibratedRed: 0.53, green: 0.75, blue: 0.82, alpha: 1.0)) // nord8
    )
}

struct AppThemeModifier: ViewModifier {
    let theme: AppTheme

    func body(content: Content) -> some View {
        content
            .tint(theme.theme.accent)
            .onAppear {
                NSApp.appearance = theme.appearance
            }
            .onChange(of: theme) { _, newTheme in
                NSApp.appearance = newTheme.appearance
            }
    }
}

struct AppFontSizeModifier: ViewModifier {
    let fontSize: AppFontSize

    func body(content: Content) -> some View {
        content
            .font(fontSize.defaultFont)
            .controlSize(fontSize.controlSize)
            .dynamicTypeSize(fontSize.dynamicTypeSize)
    }
}

struct ThemeBackgroundModifier: ViewModifier {
    let color: Color?

    func body(content: Content) -> some View {
        if let color {
            content
                .scrollContentBackground(.hidden)
                .background(color)
        } else {
            content
        }
    }
}

extension View {
    func themeBackground(_ color: Color?) -> some View {
        modifier(ThemeBackgroundModifier(color: color))
    }
}
