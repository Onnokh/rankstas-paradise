import SwiftUI

/// Sub-screen judging the plan on demand: which planned keywords have searches behind them,
/// which the vendor measured empty, and when in the year each one peaks.
///
/// The registry screen ranks PAGES by what they earned. This ranks KEYWORDS by what they are
/// worth writing, and the two orders almost never agree — which is why this is its own
/// screen rather than a panel on that one. A screen with two competing sort orders reads as
/// neither.
///
/// The rows come with the registry, cache-first, so the screen shows what is held at once
/// and never fetches on its own.
struct PlanningScreen: View {
    let overview: SiteOverview
    @Bindable var state: SiteTabState
    let rankings: RankingStore
    let preferences: PlanningPreferences
    let onRefresh: () -> Void

    @Environment(\.isTabPreview) private var isPreview

    private var report: RegistryHealthReport? { rankings.health[overview.id] }
    private var keywords: [KeywordHealth] { report?.keywords ?? [] }

    /// What the screen is looking at: a plan, nothing yet, or nothing and a reason. Every
    /// empty state below turns on it — see PlanningState for what went wrong without it.
    private var planningState: PlanningState {
        PlanningList.state(
            report: report,
            reason: rankings.healthErrors[overview.id],
            loading: loading
        )
    }

    private var unavailable: String? {
        if case let .unavailable(reason) = planningState { return reason }
        return nil
    }

    /// The difficulty a keyword has to be at or under to count as within reach: this
    /// site's own saved value, or `PlanningList.defaultReach` until the reader sets one.
    ///
    /// A rough guide across two vendors' unrelated scales, not a rule — which is why it is
    /// a slider on the screen rather than a band in the report, and why the number is
    /// printed beside it.
    private var reach: Double {
        preferences.reach(for: overview.id)
            ?? PlanningList.defaultReach(domainRating: report?.domainRating)
    }

    private var rows: [KeywordHealth] {
        PlanningList.rows(
            keywords,
            verdicts: state.planningVerdicts,
            search: state.planningSearch
        )
    }

    private var loading: Bool { rankings.loading.contains(overview.id) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // The plan's numbers lead the screen, the way the dashboard's do. No strip
                // without a report: zeros are a statement about the plan, and an
                // unanswered request is not entitled to make one — so the screens with
                // nothing to count say so in a line of prose instead.
                Group {
                    if planningState == .plan {
                        numbers
                    } else {
                        header
                    }
                }
                .padding(.top, SiteTabScreen.screenInset)
                .padding(.bottom, 24)

                controls
                    .padding(.bottom, 20)

                list

                if planningState == .plan {
                    proposed
                        .padding(.top, 20)
                }

                if let error = rankings.errors[overview.id] {
                    Text(error)
                        .foregroundStyle(Palette.coral)
                        .padding(.top, 16)
                }
            }
            .column()
            .padding(.bottom, SiteTabScreen.columnInset)
        }
        .scrollDisabled(isPreview)
    }

    // MARK: Header

    /// What the screen holds, in one line, under the tab's header row — and only when there
    /// is no report to count. With one in hand the strip below says all of this and says it
    /// as figures, so a line repeating it would be a second, older copy of the same claim.
    private var header: some View {
        Text(summary)
            .foregroundStyle(.secondary)
    }

    private var summary: String {
        if loading { return "Loading…" }
        // Nothing is claimed about the plan here, because nothing is known about it.
        return unavailable == nil
            ? "No plan to judge yet."
            : "This report did not arrive, so the plan below is not shown — not empty."
    }

    // MARK: Numbers

    /// The plan's figures in one row, plain on the panel, read like the dashboard's: a label
    /// over a large number. The demand the registry already aims at, the demand on offer
    /// beside it, then how much of the plan the vendor has answered for at all.
    ///
    /// A hairline separates those three from the market and the domain rating, as on the
    /// dashboard where it separates Search Console from the sources beside it: those two
    /// describe the SITE, not this plan — and they are what the numbers to their left mean,
    /// because a search volume is only comparable inside one market.
    private var numbers: some View {
        HStack(alignment: .top, spacing: 0) {
            Metric(
                title: "Total volume",
                value: (report?.totals.monthlyVolume ?? 0)
                    .formatted(.number.precision(.fractionLength(0))),
                footnote: "searches / month"
            )
            // Not a traffic forecast: it counts every search behind the plan, not the
            // share a first-page ranking would win.
            .help("Every search a month behind the keywords the registry already aims at. The size of the market, not a forecast of your traffic.")
            gap
            Metric(
                title: "Total proposed",
                value: proposedVolume,
                footnote: proposedFootnote
            )
            .help("The demand behind the keywords that are NOT in the registry — the proposals listed below. Nothing on the site aims at any of it yet.")
            gap
            Metric(
                title: "Measured",
                value: "\(PlanningList.measured(keywords).count)",
                footnote: measuredFootnote
            )
            .help("How much of the plan the vendor has answered for, and the denominator of every figure here. The rest were never asked about — that is a missing DataForSEO key and a sync, not a verdict on the keyword.")
            gap
            Rectangle()
                .fill(Palette.line)
                .frame(width: 1, height: 48)
            gap
            Metric(
                title: "Market",
                value: marketValue,
                footnote: marketFootnote
            )
            .help(marketHelp)
            gap
            Metric(
                title: "Domain Rating",
                value: ratingValue ?? "—",
                footnote: ratingValue == nil ? "No reading yet" : nil
            )
            .help("This site's Ahrefs domain rating. The reach threshold below starts from it, which is the only place the two vendors' scales are held against each other.")
        }
    }

    /// One flexible gap, as on the dashboard's strip: the figures sit at the two ends of the
    /// column and the room between them is shared, so the row reads as one line across the
    /// page rather than a cluster on its left.
    private var gap: some View {
        Spacer(minLength: 20)
    }

    /// The demand on offer. A dash rather than a zero while no discovery has run: a run
    /// that found nothing and no run at all are different things, and only the first is a
    /// zero the reader can act on.
    private var proposedVolume: String {
        guard let totals = rankings.proposals[overview.id]?.totals else { return "—" }
        return totals.monthlyVolume.formatted(.number.precision(.fractionLength(0)))
    }

    private var proposedFootnote: String {
        rankings.proposals[overview.id] == nil ? "None proposed" : "searches / month"
    }

    /// The denominator, in the footnote rather than the figure: "31" over "of 31 keywords"
    /// keeps the large number a count and not a ratio to be read twice.
    private var measuredFootnote: String {
        let planned = report?.totals.keywords ?? keywords.count
        return "of \(planned) \(planned == 1 ? "keyword" : "keywords")"
    }

    /// The language, large, with the country under it: language is the axis that matters —
    /// a German visitor to an English site searches in English.
    private var marketValue: String {
        guard let market = report?.market else { return "—" }
        return market.languageCode.uppercased()
    }

    private var marketFootnote: String {
        guard let market = report?.market else { return "No market set" }
        return market.label
    }

    private var marketHelp: String {
        guard let market = report?.market else {
            return "This site names no market, so its keywords are measured in the United States in English."
        }
        var help = "Every search volume on this screen is measured in \(market.summary). The same keyword has a different number in every market."
        if !market.hasDifficulty {
            help += " This market is served by Google Ads, which reports no keyword difficulty."
        }
        return help
    }

    private var ratingValue: String? {
        guard let report, let rating = report.domainRating else { return nil }
        return rating.formatted(.number.precision(.fractionLength(1)))
    }

    // MARK: Seasons

    /// How far above an even month a peak has to run before it is called a season. Every
    /// term has a highest month; this is where one becomes worth planning around. Read by
    /// the rows' Peaks column, which is where a season is shown — beside the keyword it
    /// belongs to, and the volume that says whether the season is worth aiming at.
    static let seasonalThreshold = 1.25

    // MARK: Controls

    /// One control bar over the list: what to look for on the left, where the bar for
    /// "within reach" sits on the right, and the verdicts as chips under both. The two
    /// fields share a surface so the row reads as one strip of controls and not as a text
    /// field with a loose slider beside it.
    private var controls: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 16) {
                search
                Spacer()
                reachControl
            }

            // The verdicts worth filtering on, with All in front of them. Nothing selected
            // means every row — the honest default, because the reader has not said what
            // they are looking for yet — and the All chip is that default made visible, so
            // there is one lit chip to come back to rather than three to unpick.
            //
            // Not every verdict: see PlanningList.verdictFilters for the two that are left
            // out, and why a chip that can only read 0 is worse than no chip.
            FlowRow(spacing: 6) {
                FilterChip(
                    label: "All",
                    count: keywords.count,
                    isOn: state.planningVerdicts.isEmpty,
                    action: { state.planningVerdicts.removeAll() }
                )
                .help("Every planned keyword, whatever the vendor said about it.")

                ForEach(PlanningList.verdictFilters, id: \.self) { verdict in
                    FilterChip(
                        label: verdict.label,
                        count: keywords.filter { $0.verdictKind == verdict }.count,
                        isOn: state.planningVerdicts.contains(verdict),
                        action: { toggle(verdict) }
                    )
                    .help(helpFor(verdict))
                }
            }
        }
        .disabled(isPreview)
    }

    private var search: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("Filter by keyword, cluster or page", text: $state.planningSearch)
                .textFieldStyle(.plain)
                .frame(maxWidth: 220)
            // Offered only once there is something to clear. One box narrows both lists,
            // so the way out of a filter has to be in reach of the box that set it.
            if !state.planningSearch.isEmpty {
                Button("Clear", systemImage: "xmark.circle.fill") {
                    state.planningSearch = ""
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.plain)
                .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Palette.raised, in: .rect(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.line))
    }

    /// The threshold that decides which difficulties below are coloured as reachable, in
    /// the search field's surface so the two read as one bar.
    ///
    /// No `step:` on the slider: a stepped slider draws a tick for every step on macOS, and
    /// 101 ticks under a 120-point track is a smear under the knob. The value is rounded on
    /// the way in instead, which is where whole numbers were wanted in the first place.
    private var reachControl: some View {
        HStack(spacing: 8) {
            Text("Within reach at")
                .font(.caption)
                .foregroundStyle(.secondary)
            Slider(
                value: Binding(
                    get: { reach },
                    // Saved per site as it moves, so the judgement is made once.
                    set: { preferences.setReach($0.rounded(), for: overview.id) }
                ),
                in: 0...100
            )
            .controlSize(.small)
            .frame(width: 120)
            Text(reach.formatted(.number.precision(.fractionLength(0))))
                .font(.caption.weight(.medium))
                .monospacedDigit()
                .frame(width: 24, alignment: .trailing)
            // Only offered once there is something to undo. Clearing hands the threshold
            // back to the default, which then follows the site's domain rating as that
            // moves — something a pinned number cannot do.
            if preferences.reach(for: overview.id) != nil {
                Button("Reset", systemImage: "arrow.uturn.backward") {
                    preferences.clearReach(for: overview.id)
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Back to this site's domain rating.")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Palette.raised, in: .rect(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.line))
        .help(reachHelp)
    }

    /// What moving the slider did, counted: the tiles used to carry this figure and the
    /// number belongs beside the control that sets it, not in a card three rows up.
    private var reachHelp: String {
        let within = PlanningList.withinReach(keywords, reach: reach).count
        let measured = PlanningList.measured(keywords).count
        return "\(within) of \(measured) measured keywords score at or under "
            + "\(reach.formatted(.number.precision(.fractionLength(0)))), and are coloured mint below. "
            + "Keyword difficulty and domain rating come from different vendors on unrelated "
            + "scales, so this is a guide and not a rule."
    }

    private func toggle(_ verdict: KeywordVerdict) {
        if state.planningVerdicts.contains(verdict) {
            state.planningVerdicts.remove(verdict)
        } else {
            state.planningVerdicts.insert(verdict)
        }
    }

    /// Each verdict says a different thing, and the one that matters most is that "not
    /// measured" is about us and not about the keyword.
    private func helpFor(_ verdict: KeywordVerdict) -> String {
        switch verdict {
        case .hasDemand: "The vendor found real demand behind these."
        case .noDemand: "The vendor measured zero searches. A page aimed here will not be found."
        case .unreported: "Asked, and the term is too rare for the vendor to report a volume."
        case .unmeasured: "Never asked. Says nothing about the keyword — configure a DataForSEO key and sync."
        case .brand: "Your own name. Never asked about, key or no key: volume on your brand is not something you can act on."
        }
    }

    // MARK: List

    @ViewBuilder
    private var list: some View {
        if let unavailable {
            ContentUnavailableView(
                "Plan report unavailable",
                systemImage: "exclamationmark.triangle",
                // The reason, verbatim from the server. A 404 here means the server is
                // running a build from before this report existed, which is a deploy and
                // not something the reader can fix on this screen — so it is named rather
                // than dressed up as an empty plan.
                description: Text(
                    "The server did not answer this report for \(overview.site.name). "
                        + "The registry itself loaded, so this says nothing about the plan.\n\n"
                        + unavailable
                )
            )
            .frame(minHeight: 240)
        } else if rows.isEmpty {
            ContentUnavailableView(
                keywords.isEmpty ? "No keywords planned" : "No keywords match",
                systemImage: "text.magnifyingglass",
                description: Text(
                    keywords.isEmpty
                        ? "The registry for \(overview.site.name) maps no keywords yet."
                        : "No planned keyword matches the filter."
                )
            )
            .frame(minHeight: 240)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                columnHeadings
                ForEach(rows) { keyword in
                    PlanningRow(keyword: keyword, reach: reach)
                        .equatable()
                    Divider().opacity(0.4)
                }
            }
            .padding(.vertical, 4)
            .cardSurface(cornerRadius: 12)
        }
    }

    // MARK: Proposed

    private var proposals: [KeywordProposal] {
        PlanningList.proposals(
            rankings.proposals[overview.id]?.proposals ?? [],
            search: state.planningSearch
        )
    }

    /// Keywords the site does NOT have, offered for a decision. Below the plan rather than
    /// mixed into it: a proposal is a suggestion and a planned keyword is a commitment, and
    /// one list holding both would let a reader act on the wrong one.
    @ViewBuilder
    private var proposed: some View {
        if proposals.isEmpty {
            // One dim line rather than an empty card. A reader with no proposals has
            // nothing to act on here, and a card saying so on every site is noise — but
            // the feature is invisible otherwise, so it says where they come from.
            Text("No keywords proposed. Ask an agent to run a discovery on a seed keyword.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Text("Proposed")
                        .font(.headline)
                    Text("\(proposals.count)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                    Spacer()
                    // The demand on offer, the counterpart of the Addressable tile. Only
                    // shown when nothing is filtered out, because a sum over a filtered
                    // list reads as a total and is not one.
                    if state.planningSearch.trimmingCharacters(in: .whitespaces).isEmpty,
                       let totals = rankings.proposals[overview.id]?.totals,
                       totals.monthlyVolume > 0 {
                        Text("\(totals.monthlyVolume.formatted(.number.precision(.fractionLength(0)))) searches / month on offer")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Text("Not in the registry. Accepting one is a registry row with a target page and a cluster — decisions to make on the Registry screen, not in one click here.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                ProposalsList(
                    proposals: proposals,
                    reach: reach,
                    onDismiss: { keyword in
                        Task { await rankings.dismissProposals([keyword], siteID: overview.id) }
                    }
                )
                .cardSurface(cornerRadius: 12)
            }
        }
    }

    private var columnHeadings: some View {
        HStack(spacing: PlanningRow.columnSpacing) {
            Text("Keyword")
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("Volume")
                .frame(width: PlanningRow.numberWidth, alignment: .trailing)
            Text("Difficulty")
                .frame(width: PlanningRow.numberWidth, alignment: .trailing)
            Text("Peaks")
                .frame(width: PlanningRow.peakWidth, alignment: .trailing)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }
}

/// One planned keyword: what it is aimed at, what the vendor said, and when it peaks.
///
/// `Equatable`, and drawn with `.equatable()`: the screen's body is re-evaluated whenever
/// anything the store publishes changes, and the rows do not have to be rebuilt for a
/// spinner that appeared somewhere above them.
private struct PlanningRow: View, Equatable {
    let keyword: KeywordHealth
    let reach: Double

    static let columnSpacing: CGFloat = 12
    static let numberWidth: CGFloat = 78
    static let peakWidth: CGFloat = 56

    var body: some View {
        HStack(spacing: PlanningRow.columnSpacing) {
            VStack(alignment: .leading, spacing: 2) {
                Text(keyword.keyword)
                    .font(.callout)
                HStack(spacing: 6) {
                    Text(keyword.targetUrl)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if !keyword.priority.isEmpty {
                        Text(keyword.priority)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if keyword.verdictKind != .hasDemand {
                        Text(keyword.verdictKind.label)
                            .font(.caption)
                            .foregroundStyle(
                                keyword.verdictKind == .noDemand ? Palette.coral : .secondary
                            )
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            // A measured zero is shown, because that is the case worth seeing. A null is a
            // dash: printing "0" would claim the vendor measured nothing where it reported
            // nothing.
            Text(keyword.searchVolume.map { $0.formatted(.number.precision(.fractionLength(0))) } ?? "—")
                .font(.callout)
                .monospacedDigit()
                .frame(width: PlanningRow.numberWidth, alignment: .trailing)

            difficulty
                .frame(width: PlanningRow.numberWidth, alignment: .trailing)

            Text(keyword.peakLabel(seasonalAbove: PlanningScreen.seasonalThreshold) ?? "—")
                .font(.caption)
                .foregroundStyle(
                    keyword.peakLabel(seasonalAbove: PlanningScreen.seasonalThreshold) == nil
                        ? .secondary
                        : Palette.amber
                )
                .frame(width: PlanningRow.peakWidth, alignment: .trailing)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
        // A row the vendor never answered for is dimmed, the reading the registry screen
        // gives an unindexed page: present, and not something to act on yet. A brand row
        // is dimmed for the stronger version of the same reason — it will never be
        // something to act on.
        .opacity(
            keyword.verdictKind == .unmeasured || keyword.verdictKind == .brand ? 0.55 : 1
        )
    }

    /// Difficulty, coloured against the reader's own threshold. Nil for a Google-Ads market
    /// and for a term the vendor scored none, and a dash is the honest answer for both.
    @ViewBuilder
    private var difficulty: some View {
        if let value = keyword.difficulty {
            Text(value.formatted(.number.precision(.fractionLength(0))))
                .font(.callout)
                .monospacedDigit()
                .foregroundStyle(value <= reach ? Palette.mint : Palette.coral)
                .help(difficultyHelp(value))
        } else {
            Text("—")
                .font(.callout)
                .foregroundStyle(.secondary)
                .help("The vendor reports no difficulty for this market.")
        }
    }

    private func difficultyHelp(_ value: Double) -> String {
        guard let gap = keyword.difficultyGap else {
            return "Difficulty \(value.formatted(.number.precision(.fractionLength(0))))."
        }
        let signed = gap >= 0 ? "+\(gap.formatted(.number.precision(.fractionLength(0))))" : gap.formatted(.number.precision(.fractionLength(0)))
        return "Difficulty \(value.formatted(.number.precision(.fractionLength(0)))), \(signed) against this site's domain rating."
    }
}

/// One proposed keyword: what it is, which seed found it, and what the vendor said when it
/// was proposed. The numbers are frozen at that moment, which is why they can disagree with
/// the same keyword's current metric elsewhere.
/// The proposals card's rows, virtualised.
///
/// The only `LazyVStack` in the app, and the only list that earns one: a discovery run adds
/// hundreds of proposals at once — 544 for shadertown — while every other list here is
/// bounded by something a person maintains by hand. A plain stack builds and lays out every
/// row it is handed, and the sub-screen push animates whatever the incoming screen holds, so
/// an eager stack made opening the screen cost the whole run: 522 ms of layout for 544 rows
/// against 13 ms lazy, measured in `ProposalsListTests`.
///
/// The hazard a lazy stack is banned for elsewhere (see OverviewScreen's feed, which sat at
/// 15–20% CPU idle) is a lazy stack under a REPEATING invalidation: it re-phases its realized
/// items every time. It does not apply here. Everything on this screen comes from the
/// registry read, once per session, and the site tab's 5-second live poll cannot reach it —
/// the dashboard's `live` reads are inside `dashboard`, which is not built while this screen
/// is shown, and the header's online count is its own view (`OnlineCount`), so the poll
/// invalidates a label and nothing here. Keep it that way: a `live` read in
/// `SiteTabScreen`'s header or `screen` switch would bring the hazard back.
///
/// Its own view rather than a stack inside the screen so a test can host it and time it.
struct ProposalsList: View {
    let proposals: [KeywordProposal]
    let reach: Double
    /// Takes the keyword rather than the row, so the caller owns what dismissing means.
    let onDismiss: (String) -> Void

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(proposals) { proposal in
                ProposalRow(
                    proposal: proposal,
                    reach: reach,
                    onDismiss: { onDismiss(proposal.keyword) }
                )
                .equatable()
                Divider().opacity(0.4)
            }
        }
        .padding(.vertical, 4)
    }
}

/// Not private, unlike the rows around it: its `==` is written by hand, so it can drift
/// from the fields it has to compare, and a test pins it.
struct ProposalRow: View, Equatable {
    let proposal: KeywordProposal
    let reach: Double
    let onDismiss: () -> Void

    @State private var dismissing = false

    /// Compared on its values, ignoring the closure, which cannot be compared. Sound here
    /// and not in general: the closure only ever dismisses `proposal.keyword` on the site
    /// the screen is showing, so two rows equal by these fields do the same thing.
    nonisolated static func == (lhs: ProposalRow, rhs: ProposalRow) -> Bool {
        lhs.proposal == rhs.proposal && lhs.reach == rhs.reach
    }

    var body: some View {
        HStack(spacing: PlanningRow.columnSpacing) {
            VStack(alignment: .leading, spacing: 2) {
                Text(proposal.keyword)
                    .font(.callout)
                HStack(spacing: 6) {
                    Text("from \(proposal.seed)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let source = ProposalSource(rawValue: proposal.source) {
                        Text(source.label)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .help(source.help)
                    }
                    if let intent = proposal.intent, !intent.isEmpty {
                        Text(intent)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Text(proposal.searchVolume.map { $0.formatted(.number.precision(.fractionLength(0))) } ?? "—")
                .font(.callout)
                .monospacedDigit()
                .frame(width: PlanningRow.numberWidth, alignment: .trailing)

            difficulty
                .frame(width: PlanningRow.numberWidth, alignment: .trailing)

            Button("Dismiss", systemImage: "xmark") {
                dismissing = true
                onDismiss()
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .disabled(dismissing)
            .help("Set aside. A later discovery run will not offer this keyword again.")
            .frame(width: PlanningRow.peakWidth, alignment: .trailing)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
        // Dimmed while the server has not confirmed. The row leaves when it has — not
        // before, because a dismissal is permanent and a row that vanished from a failed
        // call would read as decided.
        .opacity(dismissing ? 0.4 : 1)
    }

    /// Coloured against the reader's own threshold, like the plan's rows. A Google-Ads
    /// market reports none at all, and a dash is the honest answer.
    @ViewBuilder
    private var difficulty: some View {
        if let value = proposal.difficulty {
            Text(value.formatted(.number.precision(.fractionLength(0))))
                .font(.callout)
                .monospacedDigit()
                .foregroundStyle(value <= reach ? Palette.mint : Palette.coral)
        } else {
            Text("—")
                .font(.callout)
                .foregroundStyle(.secondary)
                .help("No difficulty. Either the vendor scored none, or this market is served by Google Ads, which does not measure it.")
        }
    }
}
