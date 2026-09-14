import SwiftUI

/// How a clickable surface answers the pointer, in one place.
///
/// Two kinds of surface wear this. Most are buttons and get it from `ClickableSurface`. A few
/// cannot be buttons — a card that answers a single click with a selection and a double-click
/// with an open is two controls in one — and those pass their own state in. Either way the
/// fills, the give and the timing come from here, so a reader learns them once.
///
/// The press state is not decoration: the HIG asks for it by name ("Always include a press
/// state for a custom button"), because a hover says only that the pointer arrived, never that
/// the click landed.
struct ClickableLook: ViewModifier {
    /// The corner radius of the surface underneath, so the fill lands exactly on it. A row
    /// that runs the full width of a pane squares off; a card repeats its own radius.
    let cornerRadius: CGFloat
    let isHovering: Bool
    let isPressed: Bool
    /// Whether the surface gives a little under the press. For a card large enough that the
    /// movement reads; a row or a rail button is too small to move without twitching.
    let givesOnPress: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            // Over the label, not under it. A card carries its own opaque surface, so a fill
            // drawn behind it would never be seen; a veil this faint reads as the card
            // lighting up and leaves the text alone.
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius)
                    .fill(fill)
                    // The veil is a picture, not a target: the surface keeps every click.
                    .allowsHitTesting(false)
            }
            .scaleEffect(scale)
            .animation(hoverMotion, value: isHovering)
            .animation(pressMotion, value: isPressed)
    }

    private var fill: Color {
        if isPressed { return Palette.pressed }
        return isHovering ? Palette.hover : .clear
    }

    /// A press is felt, not watched: barely over one percent, so the card reads as giving
    /// rather than as shrinking.
    private var scale: CGFloat {
        givesOnPress && !reduceMotion && isPressed ? 0.985 : 1
    }

    /// Short enough to feel like the surface answering, long enough not to flicker when the
    /// pointer crosses a border. Hover happens constantly, and the HIG warns off motion on
    /// the interactions that occur most.
    private var hoverMotion: Animation? {
        reduceMotion ? nil : .snappy(duration: 0.12)
    }

    /// Down instantly, up over a moment.
    ///
    /// Feedback motion follows the gesture, and nothing follows a click like arriving with
    /// it: a press that ramps in reads as the app lagging behind the mouse. The release is
    /// where the animation belongs — it is the surface settling, and cutting it makes the
    /// button feel dead in the hand. Read with the new value, so the down edge gets no
    /// animation and the up edge gets the ease.
    private var pressMotion: Animation? {
        guard !reduceMotion else { return nil }
        return isPressed ? nil : .easeOut(duration: 0.14)
    }
}

/// The one way a button answers the pointer.
///
/// Not for anything that moves under a still pointer. A view that sweeps past the cursor gets
/// no exit event, so its hover sticks on, and asking for hover during the peek's travel put
/// `enqueueHoverUpdateIfNeeded` near the top of a profile — see `PeekOverlay`. Hover things
/// that sit still.
struct ClickableSurface: ButtonStyle {
    var cornerRadius: CGFloat = 0
    var givesOnPress: Bool = false

    func makeBody(configuration: Configuration) -> some View {
        Surface(configuration: configuration, cornerRadius: cornerRadius, givesOnPress: givesOnPress)
    }

    /// A view of its own, because a `ButtonStyle` cannot hold the hover state itself.
    private struct Surface: View {
        let configuration: Configuration
        let cornerRadius: CGFloat
        let givesOnPress: Bool

        @State private var isHovering = false

        var body: some View {
            configuration.label
                .clickableLook(
                    cornerRadius: cornerRadius,
                    isHovering: isHovering,
                    isPressed: configuration.isPressed,
                    givesOnPress: givesOnPress
                )
                .contentShape(.rect(cornerRadius: cornerRadius))
                .onHover { isHovering = $0 }
        }
    }
}

extension View {
    /// Makes a custom button answer the pointer the way the rest of the app does.
    func clickableSurface(cornerRadius: CGFloat = 0, givesOnPress: Bool = false) -> some View {
        buttonStyle(ClickableSurface(cornerRadius: cornerRadius, givesOnPress: givesOnPress))
    }

    /// The same look, for a surface that cannot be a button and tracks its own state.
    func clickableLook(
        cornerRadius: CGFloat,
        isHovering: Bool,
        isPressed: Bool,
        givesOnPress: Bool = false
    ) -> some View {
        modifier(ClickableLook(
            cornerRadius: cornerRadius,
            isHovering: isHovering,
            isPressed: isPressed,
            givesOnPress: givesOnPress
        ))
    }
}
