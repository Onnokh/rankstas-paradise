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
    let onBack: () -> Void
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

    /// The difficulty a keyword has to be at or under to count as within reach. Defaults to
    /// the site's own domain rating, and the reader moves it — this is a rough guide across
    /// two vendors' unrelated scales, not a rule, so it belongs on the screen where it can
    /// be seen rather than baked into the report.
    private var reach: Double {
        state.planningReach ?? report?.domainRating ?? 30
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
                header
                    .padding(.top, SiteTabScreen.columnInset)
                    .padding(.bottom, 24)

                // No tiles without a report. Three zeros are a statement about the plan,
                // and an unanswered request is not entitled to make one.
                if planningState == .plan {
                    tiles
                        .padding(.bottom, 20)
                }

                if !upcoming.isEmpty {
                    season
                        .padding(.bottom, 20)
                }

                controls
                    .padding(.bottom, 20)

                list

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

    private var header: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Button(overview.site.name, systemImage: "chevron.left", action: onBack)
                    .keyboardShortcut(isPreview ? nil : KeyboardShortcut("[", modifiers: .command))
                Spacer()
                if loading {
                    ProgressView().controlSize(.small)
                }
                Button("Refresh", systemImage: "arrow.clockwise", action: onRefresh)
                    .labelStyle(.iconOnly)
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .disabled(loading)
                    .help("Refresh (⌘R)")
            }

            Text("Planning")
                .font(.largeTitle)

            Text(summary)
                .foregroundStyle(.secondary)
        }
    }

    /// What the plan is, in one line. The market is named because a search volume without it
    /// is ambiguous — the same keyword has a different number in every country.
    private var summary: String {
        guard let report else {
            if loading { return "Loading…" }
            // Nothing is claimed about the plan here, because nothing is known about it.
            return unavailable == nil
                ? "No plan to judge yet."
                : "This report did not arrive, so the plan below is not shown — not empty."
        }
        var parts = ["\(report.totals.keywords) \(report.totals.keywords == 1 ? "keyword" : "keywords")"]
        if report.totals.unmeasured < report.totals.keywords {
            parts.append("\(report.totals.keywords - report.totals.unmeasured) measured")
        }
        if let market = report.market { parts.append(market.summary) }
        if let rating = report.domainRating {
            parts.append("domain rating \(rating.formatted(.number.precision(.fractionLength(0))))")
        }
        return parts.joined(separator: " · ")
    }

    // MARK: Tiles

    private var tiles: some View {
        HStack(spacing: 10) {
            tile(
                "Addressable",
                value: (report?.totals.monthlyVolume ?? 0)
                    .formatted(.number.precision(.fractionLength(0))),
                note: "searches / month",
                // Not a traffic forecast: it counts every search behind the plan, not the
                // share a first-page ranking would win.
                help: "Every search a month behind the keywords the vendor found demand for. The size of the market, not a forecast of your traffic."
            )
            tile(
                "Within reach",
                value: "\(PlanningList.withinReach(keywords, reach: reach).count) of \(PlanningList.measured(keywords).count)",
                note: "difficulty at or under \(reach.formatted(.number.precision(.fractionLength(0))))",
                help: "Counted against the threshold below, which you set. Keyword difficulty and domain rating come from different vendors on unrelated scales, so this is a guide and not a rule."
            )
            tile(
                "Aimed at nothing",
                value: "\(report?.totals.noDemand ?? 0)",
                note: "measured, no demand",
                help: "The vendor looked and found no searches. These are the rows to act on — a page aimed here will not be found.",
                tint: (report?.totals.noDemand ?? 0) > 0 ? Palette.coral : nil
            )
        }
    }

    private func tile(
        _ label: String,
        value: String,
        note: String,
        help: String,
        tint: Color? = nil
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title2)
                .foregroundStyle(tint ?? .primary)
                .monospacedDigit()
            Text(note)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .cardSurface(cornerRadius: 10)
        .help(help)
    }

    // MARK: Season

    /// Keywords whose demand peaks soon, soonest first. The planning part of the screen: a
    /// term that peaks every October needs its page to exist before then, so the useful
    /// order here is "next", not "biggest".
    private var upcoming: [KeywordHealth] {
        PlanningList.upcoming(
            keywords,
            from: Calendar.current.component(.month, from: Date()),
            seasonalAbove: PlanningScreen.seasonalThreshold
        )
    }

    /// How far above an even month a peak has to run before it is called a season. Every
    /// term has a highest month; this is where one becomes worth planning around.
    static let seasonalThreshold = 1.25

    private var season: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Peaks next")
                .font(.caption)
                .foregroundStyle(.secondary)
            FlowRow(spacing: 6) {
                ForEach(upcoming.prefix(6)) { keyword in
                    HStack(spacing: 5) {
                        Text(keyword.keyword)
                        if let month = keyword.peakLabel(seasonalAbove: PlanningScreen.seasonalThreshold) {
                            Text(month)
                                .foregroundStyle(Palette.amber)
                        }
                    }
                    .font(.caption)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Palette.line.opacity(0.7), in: .capsule)
                    .help(seasonHelp(keyword))
                }
            }
        }
    }

    private func seasonHelp(_ keyword: KeywordHealth) -> String {
        guard let seasonality = keyword.seasonality else { return keyword.keyword }
        let times = seasonality.formatted(.number.precision(.fractionLength(1)))
        return "Its peak month runs \(times)× an average month, over the years the vendor holds."
    }

    // MARK: Controls

    private var controls: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 20) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                    TextField("Filter by keyword, cluster or page", text: $state.planningSearch)
                        .textFieldStyle(.plain)
                        .frame(maxWidth: 260)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Palette.raised, in: .rect(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.line))

                Spacer()

                HStack(spacing: 8) {
                    Text("Within reach at")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Slider(
                        value: Binding(
                            get: { reach },
                            set: { state.planningReach = $0 }
                        ),
                        in: 0...100,
                        step: 1
                    )
                    .frame(width: 140)
                    Text(reach.formatted(.number.precision(.fractionLength(0))))
                        .font(.subheadline)
                        .monospacedDigit()
                        .frame(width: 22, alignment: .trailing)
                }
            }

            // The four verdicts, as filters. Nothing selected means every row, which is the
            // honest default: the reader has not said what they are looking for yet.
            HStack(spacing: 6) {
                ForEach(KeywordVerdict.allCases, id: \.self) { verdict in
                    let count = keywords.filter { $0.verdictKind == verdict }.count
                    Button {
                        toggle(verdict)
                    } label: {
                        Text("\(verdict.label) \(count)")
                            .font(.caption)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 4)
                            .background(
                                state.planningVerdicts.contains(verdict)
                                    ? Palette.acid.opacity(0.18)
                                    : Palette.line.opacity(0.5),
                                in: .capsule
                            )
                            .overlay(
                                Capsule().strokeBorder(
                                    state.planningVerdicts.contains(verdict)
                                        ? Palette.acid.opacity(0.6)
                                        : .clear
                                )
                            )
                    }
                    .buttonStyle(.plain)
                    .disabled(count == 0)
                    .opacity(count == 0 ? 0.4 : 1)
                    .help(helpFor(verdict))
                }
            }
        }
        .disabled(isPreview)
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
                    Divider().opacity(0.4)
                }
            }
            .padding(.vertical, 4)
            .cardSurface(cornerRadius: 12)
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
private struct PlanningRow: View {
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
        // gives an unindexed page: present, and not something to act on yet.
        .opacity(keyword.verdictKind == .unmeasured ? 0.55 : 1)
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
