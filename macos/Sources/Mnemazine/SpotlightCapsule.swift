import SwiftUI

struct SpotlightCapsule: ViewModifier {
    let id: String
    let namespace: Namespace.ID
    var circle = false
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: circle ? 21 : 32))
        } else if #available(macOS 26.0, *) {
            if circle {
                content.glassEffect(.regular.interactive(), in: .circle)
                    .glassEffectID(id, in: namespace)
                    .glassEffectTransition(reduceMotion ? .identity : .matchedGeometry)
            } else {
                content.glassEffect(.regular, in: .capsule)
                    .glassEffectID(id, in: namespace)
                    .glassEffectTransition(reduceMotion ? .identity : .matchedGeometry)
            }
        } else {
            content.background(.regularMaterial, in: RoundedRectangle(cornerRadius: circle ? 21 : 32))
        }
    }
}
