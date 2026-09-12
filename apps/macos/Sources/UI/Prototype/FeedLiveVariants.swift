import SwiftUI

// PROTOTYPE — throwaway. Not for main. See `FeedPrototype` for the question.
//
// Round two. The first five shapes were all arrangements of records — rows, lanes, tiles,
// flows, cards — and a record does not move, so none of them felt live. These four are
// drawn from the clock instead of from the poll: the picture changes between polls, so the
// card is alive even in the four seconds when nothing new has arrived.
//
// Motion costs a frame, which in this app is the thing to be careful with. Three rules hold
// it down: every schedule is paused when the Overview is not the tab in front (see
// `FeedPrototype.isLive`); the drawing is one `Canvas` pass, so a busy half hour costs the
// same frame as a quiet one; and the one variant that draws real text ticks once a second,
// not once a frame.

// MARK: - F · Pulse

/// The sites as rooms, and the people in them as points of light. A person arrives in the
/// middle and is pushed outwards by the people who arrive after them; the light they carry
/// fades as they go quiet, and every page load or action sends a ring out from them.
///
/// It counts nothing and ranks nothing. It answers one question, continuously and from
/// across the room: is anything happening, and where?
struct FeedPulseVariant: View {
    let shapes: FeedShapes
    let isLive: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !isLive)) { context in
                FeedPulseField(shapes: shapes, at: context.date)
            }
            .frame(height: 300)

            Text("A point is a person, newest on the outside. It dims as they go quiet, and rings when they do something.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }
}

/// One frame of the field. Separated from its schedule so a still can be drawn of any
/// instant — see `FeedPrototypeStillsTests`.
struct FeedPulseField: View {
    let shapes: FeedShapes
    let at: Date

    /// How long a ring takes to travel out and fade. Long, because the poll lands in
    /// batches: slow ripples read as water, five rings at once reads as a strobe.
    private static let ring: TimeInterval = 8
    /// How long a person's light takes to fall away once they stop.
    private static let cool: TimeInterval = 120

    var body: some View {
        Canvas(rendersAsynchronously: false) { context, size in
            draw(in: context, size: size)
        }
        .accessibilityHidden(true)
    }

    private func draw(in context: GraphicsContext, size: CGSize) {
        let sites = shapes.columns
        guard !sites.isEmpty else { return }
        let time = at.timeIntervalSinceReferenceDate
        let band = size.width / CGFloat(sites.count)

        for (index, site) in sites.enumerated() {
            let centre = CGPoint(x: band * (CGFloat(index) + 0.5), y: size.height * 0.46)
            // Arrival order, oldest first: the room fills from the middle outwards.
            let people = shapes.visits
                .filter { $0.siteID == site.id }
                .sorted { $0.firstAt < $1.firstAt }
            let spread = min(band, size.height) * 0.42

            // The room itself, breathing at the rate of its own traffic.
            let busy = min(Double(site.views + site.events) / 40, 1)
            let breath = 1 + 0.02 * sin(time * (0.5 + busy))
            context.fill(
                Path(ellipseIn: CGRect(
                    x: centre.x - spread * breath,
                    y: centre.y - spread * breath,
                    width: spread * 2 * breath,
                    height: spread * 2 * breath
                )),
                with: .color(visitsColor.opacity(0.03 + 0.05 * busy))
            )

            for (order, person) in people.enumerated() {
                // A golden-angle spiral: stable for one person however many others arrive,
                // and evenly spread without any two ever landing on each other.
                let angle = Double(order) * 2.399963
                let distance = spread * sqrt(Double(order) / Double(max(people.count, 6))) * 0.9
                let seed = Double(abs(person.visitor.hashValue % 1000)) / 1000
                let drift = CGPoint(
                    x: 5 * sin(time * 0.4 + seed * 6.28),
                    y: 4 * cos(time * 0.31 + seed * 6.28)
                )
                let point = CGPoint(
                    x: centre.x + CGFloat(cos(angle) * distance) + drift.x,
                    y: centre.y + CGFloat(sin(angle) * distance) + drift.y
                )

                let silence = at.timeIntervalSince(person.lastAt)
                let light = exp(-max(silence, 0) / Self.cool)
                let radius = 4 + min(CGFloat(person.steps.count), 12) * 0.8

                // The halo first, as two soft rings rather than a blur: a blur filter here
                // is drawn once per person per frame.
                if person.isOnline {
                    context.fill(
                        Path(ellipseIn: CGRect(x: point.x - radius * 2.6, y: point.y - radius * 2.6, width: radius * 5.2, height: radius * 5.2)),
                        with: .color(visitsColor.opacity(0.07 * light))
                    )
                    context.fill(
                        Path(ellipseIn: CGRect(x: point.x - radius * 1.7, y: point.y - radius * 1.7, width: radius * 3.4, height: radius * 3.4)),
                        with: .color(visitsColor.opacity(0.10 * light))
                    )
                }

                context.fill(
                    Path(ellipseIn: CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)),
                    with: .color(person.isOnline
                        ? visitsColor.opacity(0.35 + 0.65 * light)
                        : Color.secondary.opacity(0.18 + 0.2 * light))
                )

                // What they did, travelling outwards.
                for step in person.steps {
                    let age = at.timeIntervalSince(step.at)
                    guard age >= 0, age < Self.ring else { continue }
                    let travel = age / Self.ring
                    let eased = 1 - pow(1 - travel, 3)
                    let ringRadius = radius + 62 * eased
                    let fade = pow(1 - travel, 2)
                    context.stroke(
                        Path(ellipseIn: CGRect(x: point.x - ringRadius, y: point.y - ringRadius, width: ringRadius * 2, height: ringRadius * 2)),
                        with: .color(step.isEvent ? Palette.acid.opacity(0.75 * fade) : visitsColor.opacity(0.5 * fade)),
                        lineWidth: step.isEvent ? 2 : 1
                    )
                }
            }

            // The room's name, under it.
            context.draw(
                Text(site.name).font(.callout.weight(.medium)),
                at: CGPoint(x: centre.x, y: size.height - 26),
                anchor: .center
            )
            context.draw(
                Text("\(site.online) online")
                    .font(.caption)
                    .foregroundStyle(site.online > 0 ? AnyShapeStyle(visitsColor) : AnyShapeStyle(.tertiary)),
                at: CGPoint(x: centre.x, y: size.height - 8),
                anchor: .center
            )
        }
    }
}

// MARK: - G · Trace

/// One instrument trace per site, running right to left under a fixed "now" edge. The trace
/// slides on every frame because its x comes from the clock, so the half hour is visibly
/// draining away even while no poll has landed — and a spike arriving at the right edge is
/// something happening, not a row appearing.
struct FeedTraceVariant: View {
    let shapes: FeedShapes
    let isLive: Bool

    private static let stripHeight: CGFloat = 74

    var body: some View {
        let sites = shapes.columns.prefix(4)
        VStack(spacing: 0) {
            ForEach(Array(sites)) { site in
                TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !isLive)) { context in
                    FeedTraceStrip(shapes: shapes, site: site, at: context.date)
                }
                .frame(height: Self.stripHeight)
                .overlay(alignment: .bottom) {
                    if site.id != sites.last?.id {
                        Palette.line.frame(height: 1)
                    }
                }
            }
        }
    }
}

struct FeedTraceStrip: View {
    let shapes: FeedShapes
    let site: FeedSiteColumn
    let at: Date

    /// The name and the head count stand still; only the trace moves.
    private static let gutter: CGFloat = 150

    var body: some View {
        Canvas(rendersAsynchronously: false) { context, size in
            draw(in: context, size: size)
        }
        .accessibilityHidden(true)
    }

    private func draw(in context: GraphicsContext, size: CGSize) {
        let window = max(Double(shapes.windowMinutes) * 60, 1)
        let trackX = Self.gutter
        let trackWidth = max(size.width - trackX - 16, 1)
        let baseline = size.height - 20

        func x(_ date: Date) -> CGFloat {
            trackX + trackWidth * CGFloat(1 - min(max(at.timeIntervalSince(date) / window, 0), 1))
        }

        context.draw(
            Text(site.name).font(.callout.weight(.medium)),
            at: CGPoint(x: 0, y: size.height / 2 - 9),
            anchor: .leading
        )
        context.draw(
            Text("\(site.online) online")
                .font(.caption)
                .foregroundStyle(site.online > 0 ? AnyShapeStyle(visitsColor) : AnyShapeStyle(.tertiary)),
            at: CGPoint(x: 0, y: size.height / 2 + 9),
            anchor: .leading
        )

        var base = Path()
        base.move(to: CGPoint(x: trackX, y: baseline))
        base.addLine(to: CGPoint(x: trackX + trackWidth, y: baseline))
        context.stroke(base, with: .color(Palette.line), lineWidth: 1)

        // The events of this site, as spikes standing on the line.
        let visits = shapes.visits.filter { $0.siteID == site.id }
        var newest: (step: FeedStep, x: CGFloat)?
        for visit in visits {
            for step in visit.steps {
                let age = at.timeIntervalSince(step.at)
                guard age >= 0, age < window else { continue }
                let position = x(step.at)
                let height: CGFloat = step.isEvent ? 34 : 14 + min(CGFloat(step.repeats), 6) * 3
                // Just landed: a spike is brighter for its first seconds, which is what makes
                // the right-hand edge the place to look.
                let fresh = max(0, 1 - age / 12)
                var spike = Path()
                spike.move(to: CGPoint(x: position, y: baseline))
                spike.addLine(to: CGPoint(x: position, y: baseline - height))
                context.stroke(
                    spike,
                    with: .color(step.isEvent
                        ? Palette.acid.opacity(0.55 + 0.45 * fresh)
                        : visitsColor.opacity(0.35 + 0.55 * fresh)),
                    lineWidth: step.isEvent ? 2.5 : 1.5
                )
                if step.isEvent {
                    context.fill(
                        Path(ellipseIn: CGRect(x: position - 3, y: baseline - height - 3, width: 6, height: 6)),
                        with: .color(Palette.acid.opacity(0.6 + 0.4 * fresh))
                    )
                }
                if newest == nil || step.at > newest!.step.at {
                    newest = (step, position)
                }
            }
        }

        // The newest thing, named beside its own spike, fading out over half a minute.
        if let newest {
            let age = at.timeIntervalSince(newest.step.at)
            let fade = max(0, 1 - age / 30)
            if fade > 0.02 {
                context.draw(
                    Text(FeedShapes.short(newest.step.label, limit: 30))
                        .font(.caption)
                        .foregroundStyle(newest.step.isEvent
                            ? Palette.acid.opacity(fade)
                            : Color.secondary.opacity(fade)),
                    at: CGPoint(x: min(newest.x, trackX + trackWidth) - 8, y: 16),
                    anchor: .trailing
                )
            }
        }

        // Now: the edge everything runs towards.
        var edge = Path()
        edge.move(to: CGPoint(x: trackX + trackWidth, y: 6))
        edge.addLine(to: CGPoint(x: trackX + trackWidth, y: baseline + 4))
        context.stroke(edge, with: .color(Palette.acid.opacity(0.35)), lineWidth: 1)
    }
}

// MARK: - H · Now

/// Only the people who are on the sites this minute, one tile each, in the order they
/// arrived. Nothing scrolls and nothing is added at the top: a tile appears when somebody
/// arrives, changes under the pointer as they move through the site, cools as they go quiet,
/// and is gone when they are. The room, not the register.
struct FeedNowVariant: View {
    let shapes: FeedShapes
    let isLive: Bool

    var body: some View {
        // Once a second is enough to see a tile cool: the words are real views, and
        // re-laying them out on every frame is the expensive way to do nothing.
        TimelineView(.periodic(from: .now, by: 1)) { context in
            FeedNowRoom(shapes: shapes, at: isLive ? context.date : shapes.end)
        }
    }
}

struct FeedNowRoom: View {
    let shapes: FeedShapes
    let at: Date

    private static let columns = 3

    var body: some View {
        let here = shapes.visits
            .filter(\.isOnline)
            .sorted { $0.firstAt < $1.firstAt }
        VStack(alignment: .leading, spacing: 10) {
            if here.isEmpty {
                VStack(spacing: 8) {
                    Text("Nobody on the sites right now.")
                        .foregroundStyle(.secondary)
                    if let last = shapes.visits.first {
                        Text("The last person left \(last.age).")
                            .font(.callout)
                            .foregroundStyle(.tertiary)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 140, alignment: .center)
            } else {
                ForEach(Array(stride(from: 0, to: here.count, by: Self.columns)), id: \.self) { start in
                    HStack(alignment: .top, spacing: 10) {
                        ForEach(here[start..<min(start + Self.columns, here.count)]) { person in
                            FeedNowTile(person: person, at: at)
                        }
                        // The last row keeps the others' width rather than stretching.
                        if here.count - start < Self.columns {
                            ForEach(0..<(Self.columns - (here.count - start)), id: \.self) { _ in
                                Color.clear.frame(maxWidth: .infinity)
                            }
                        }
                    }
                }
                Text("Everyone seen in the last five minutes, in the order they arrived.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
    }
}

private struct FeedNowTile: View {
    let person: FeedVisit
    let at: Date

    /// After this long without a sign, a person is not here any more.
    private static let cool: TimeInterval = FeedShapes.onlineWindow

    var body: some View {
        let silence = max(at.timeIntervalSince(person.lastAt), 0)
        let warmth = max(0, 1 - silence / Self.cool)
        let step = person.lastStep
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(person.flag)
                Text(person.siteName)
                    .fontWeight(.medium)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if let returns = person.returns {
                    Text(returns)
                        .monospacedDigit()
                        .foregroundStyle(visitsColor)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            HStack(spacing: 6) {
                if step?.isEvent == true {
                    Image(systemName: step?.kind.symbol ?? "bolt")
                        .font(.caption)
                        .foregroundStyle(Palette.acid)
                }
                Text(step?.label ?? "—")
                    .font(.title3.weight(step?.isEvent == true ? .semibold : .regular))
                    .foregroundStyle(step?.isEvent == true ? AnyShapeStyle(Palette.acid) : AnyShapeStyle(.primary))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            HStack(spacing: 6) {
                Text("\(person.length) here")
                Text("·")
                Text(silence < 10 ? "just now" : "\(FeedShapes.span(silence)) quiet")
                    .monospacedDigit()
                Spacer(minLength: 4)
            }
            .font(.caption)
            .foregroundStyle(.tertiary)

            // The tile's own clock: full when they just did something, empty when they are
            // about to drop out of the room.
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Palette.line)
                    Capsule()
                        .fill(visitsColor.opacity(0.35 + 0.65 * warmth))
                        .frame(width: max(2, geometry.size.width * warmth))
                }
            }
            .frame(height: 3)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .help(person.who)
        .background(visitsColor.opacity(0.04 + 0.08 * warmth), in: .rect(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(visitsColor.opacity(0.12 + 0.3 * warmth)))
    }
}

// MARK: - I · Stage

/// One thing at a time, said in words, large enough to read from the other side of the desk.
/// The card holds a moment for a few seconds, then fades to the next — so an idle window
/// still has something moving in it, and a busy one reads like an announcer rather than a
/// list. Nothing is counted here and nothing is kept: it is the opposite bet from the log.
struct FeedStageVariant: View {
    let shapes: FeedShapes
    let isLive: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !isLive)) { context in
            FeedStageCard(shapes: shapes, at: context.date)
        }
    }
}

struct FeedStageCard: View {
    let shapes: FeedShapes
    let at: Date

    /// How long one moment holds the stage, and how much of that is the fade at each end.
    private static let hold: TimeInterval = 3.4
    private static let fade: TimeInterval = 0.5

    var body: some View {
        let moments = Array(shapes.moments.prefix(12))
        let elapsed = at.timeIntervalSinceReferenceDate
        let index = moments.isEmpty ? 0 : Int(elapsed / Self.hold) % moments.count
        let phase = elapsed.truncatingRemainder(dividingBy: Self.hold)
        let opacity = min(1, phase / Self.fade) * min(1, (Self.hold - phase) / Self.fade)

        VStack(alignment: .leading, spacing: 18) {
            if let moment = moments.isEmpty ? nil : moments[index] {
                VStack(alignment: .center, spacing: 10) {
                    HStack(spacing: 8) {
                        Text(moment.who)
                        if let phrase = moment.returnsPhrase {
                            Text("·")
                            Text(phrase)
                                .monospacedDigit()
                                .foregroundStyle(visitsColor)
                        }
                    }
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(moment.verb)
                            .font(.title2)
                            .foregroundStyle(.secondary)
                        Text(moment.object)
                            .font(.system(size: 34, weight: .semibold))
                            .foregroundStyle(moment.isAction ? AnyShapeStyle(Palette.acid) : AnyShapeStyle(.primary))
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }

                    HStack(spacing: 8) {
                        Text(moment.siteName)
                            .fontWeight(.medium)
                        if let place = moment.place {
                            Text("·")
                            Text(place)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Text("·")
                        Text(moment.age)
                            .monospacedDigit()
                    }
                    .font(.callout)
                    .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 132, alignment: .center)
                .opacity(opacity)
                // A little lift as it arrives, so the change is a movement and not a cut.
                .offset(y: 6 * (1 - min(1, phase / Self.fade)))
            }

            // Where in the queue the stage is, and how much of the window is behind it.
            HStack(spacing: 5) {
                ForEach(Array(moments.enumerated()), id: \.element.id) { position, moment in
                    Capsule()
                        .fill(position == index
                            ? (moment.isAction ? Palette.acid : visitsColor)
                            : Palette.line)
                        .frame(width: position == index ? 22 : 8, height: 3)
                }
                Spacer(minLength: 12)
                Text("\(shapes.signals.count) actions · \(Int(shapes.pulse.reduce(0, +))) page loads · last \(shapes.windowMinutes)m")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
            }
        }
    }
}
