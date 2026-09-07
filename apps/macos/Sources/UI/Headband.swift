import SwiftUI

/// The style guide's headband: a short bar sheared 24° off vertical, taken from the
/// mascot's own headband. The guide uses it as the mark for the active row in a list,
/// and as the rule that opens a section — always the same slant, always acid.
///
/// The shear is taken out of the bar's own width rather than added to it, so a headband
/// occupies exactly the box it is given and the slots in a list stay aligned.
struct Headband: Shape {
    static let slant = Angle.degrees(24)
    /// The guide draws the list marker at 14×4.
    static let markerSize = CGSize(width: 14, height: 4)

    func path(in rect: CGRect) -> Path {
        let shear = min(rect.height * tan(Self.slant.radians), rect.width)
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + shear, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - shear, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

/// The active tab's marker, sitting just inside the ⌘-number cap. An inactive tab has no
/// marker and no slot for one: the band's width is what animates, so nothing stands off a
/// reserved column.
///
/// The band takes its spacing from the row it sits in rather than folding a gap of its own.
/// The `Spacer` ahead of it absorbs the slack, so a collapsed band leaves the title and the
/// cap exactly where they would be without it.
struct HeadbandMarker: View {
    let isActive: Bool

    var body: some View {
        Headband()
            .fill(Palette.acid)
            .frame(width: Headband.markerSize.width, height: Headband.markerSize.height)
            // The band enters from under the cap beside it; the clip is what it emerges from.
            .offset(x: isActive ? 0 : 6)
            .opacity(isActive ? 1 : 0)
            .frame(width: isActive ? Headband.markerSize.width : 0, alignment: .trailing)
            .clipped()
            .accessibilityHidden(true)
    }
}
