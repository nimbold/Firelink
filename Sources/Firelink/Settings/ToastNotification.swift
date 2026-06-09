import SwiftUI

struct ToastNotification: ViewModifier {
    var message: String
    @Binding var isShowing: Bool

    func body(content: Content) -> some View {
        ZStack(alignment: .bottom) {
            content
            
            if isShowing {
                VStack {
                    Spacer()
                    Text(message)
                        .font(.subheadline.weight(.medium))
                        .foregroundColor(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(
                            Capsule()
                                .fill(Color.black.opacity(0.8))
                                .shadow(color: .black.opacity(0.2), radius: 8, x: 0, y: 4)
                        )
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .padding(.bottom, 24)
                }
                .zIndex(1)
                .animation(.spring(response: 0.3, dampingFraction: 0.7), value: isShowing)
                .task {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    withAnimation {
                        isShowing = false
                    }
                }
            }
        }
    }
}

extension View {
    func toast(isShowing: Binding<Bool>, message: String) -> some View {
        self.modifier(ToastNotification(message: message, isShowing: isShowing))
    }
}
