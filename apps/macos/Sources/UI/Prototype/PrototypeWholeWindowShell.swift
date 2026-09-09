import SwiftUI

// PROTOTYPE — throwaway. Not for main.
//
// The whole-window variants: the title-bar tab pills and the peek are gone; the shell owns
// the window and decides where sites and pages live.
//
//   D — one sidebar on the left, Overview then every site with its pages as children
//   E — the pages are the title-bar tabs; the site is a favicon switch at the trailing end
//   F — Miller columns: sites, then that site's pages, then the content
//   G — a breadcrumb of two menus, "Printfeest ▾ › Registry ▾", and a ⌘K jump palette
//   K — a Slack-like icon rail: site favicons above a hairline, page icons below it
//   L — one header row: sites on the left, the period and the pages on the right
//
// The content is `TabContentStack` as shipped, so mounting and data loading are unchanged.
struct PrototypeWholeWindowShell: View {
    let variant: NavigationPrototype.Variant
    let size: CGSize
    let chrome: WindowChrome
    let workspace: Workspace
    let model: OverviewModel
    let history: HistoryStore
    let rankings: RankingStore
    let preferences: PlanningPreferences
    let live: LiveStore
    let favicons: FaviconStore
    let actions: TabActions
    let onSelect: (TabID) -> Void

    @State private var paletteShown = false

    /// The title bar's height: the traffic lights' row.
    private var topInset: CGFloat { chrome.buttonsCenterY * 2 }
    private var inset: CGFloat { PeekLayout.contentInset }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Palette.void

            switch variant {
            case .globalSidebar: sidebarLayout
            case .pageFirst: pageFirstLayout
            case .columns: columnsLayout
            case .breadcrumb: breadcrumbLayout
            case .rail: railLayout
            case .twoAxis: twoAxisLayout
            default: pane
            }

            if paletteShown {
                JumpPalette(
                    entries: paletteEntries,
                    dismiss: { paletteShown = false },
                    choose: { entry in
                        paletteShown = false
                        go(entry.tab, entry.section)
                    }
                )
                .frame(width: size.width, height: size.height, alignment: .top)
                .padding(.top, 80)
                .transition(.opacity)
            }

            Button("Jump to…") { paletteShown.toggle() }
                .keyboardShortcut("k", modifiers: .command)
                .opacity(0)
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .animation(.snappy(duration: 0.15), value: paletteShown)
    }

    // MARK: Helpers

    private var activeSiteID: Site.ID? {
        if case .site(let siteID) = workspace.activeTabID { return siteID }
        return nil
    }

    private var activeOverview: SiteOverview? {
        activeSiteID.flatMap { siteID in model.overviews.first { $0.id == siteID } }
    }

    private func go(_ tab: TabID, _ section: SiteSection? = nil) {
        onSelect(tab)
        if case .site(let siteID) = tab, let section {
            workspace.state(for: siteID).section = section
        }
    }

    private func count(_ siteID: Site.ID, _ section: SiteSection) -> Int? {
        switch section {
        case .registry: rankings.registry[siteID]?.count
        case .planning: rankings.health[siteID]?.keywords.count
        case .dashboard, .log: nil
        }
    }

    private func online(_ siteID: Site.ID) -> String? {
        live.reports[siteID]?.live.map { "\($0.onlineNow.formatted(.number.precision(.fractionLength(0))))" }
    }

    private var refreshing: Bool {
        model.isRefreshing || (activeSiteID.map { history.refreshing.contains($0) } ?? false)
    }

    /// The shipped content stack, in a rounded pane.
    private var pane: some View {
        GeometryReader { proxy in
            TabContentStack(
                workspace: workspace,
                model: model,
                history: history,
                rankings: rankings,
                preferences: preferences,
                live: live,
                favicons: favicons,
                actions: actions,
                height: proxy.size.height
            )
        }
    }

    private func favicon(_ siteID: Site.ID, size: CGFloat, radius: CGFloat = 4) -> some View {
        Group {
            if let icon = favicons.image(for: siteID) {
                icon.resizable().interpolation(.high).scaledToFit().clipShape(.rect(cornerRadius: radius))
            } else {
                Image(systemName: "globe").font(.callout).foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
    }

    private var paletteEntries: [JumpPalette.Entry] {
        var entries = [JumpPalette.Entry(title: "Overview", detail: "Every site", tab: .overview, section: nil)]
        for site in model.sites {
            for section in SiteSection.allCases {
                entries.append(JumpPalette.Entry(title: site.name, detail: section.label, tab: .site(site.id), section: section))
            }
        }
        return entries
    }

    // MARK: D — global sidebar

    private var sidebarLayout: some View {
        HStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    SidebarRow(label: "Overview", isActive: workspace.activeTabID == .overview, level: 0, trailing: nil) {
                        Image(systemName: "globe").font(.callout).foregroundStyle(.secondary).frame(width: 18)
                    } action: { go(.overview) }

                    ForEach(model.sites) { site in
                        let isSite = activeSiteID == site.id
                        let section = workspace.state(for: site.id).section
                        Text(site.name)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .tracking(0.4)
                            .textCase(.uppercase)
                            .padding(.horizontal, 12)
                            .padding(.top, 18)
                            .padding(.bottom, 6)
                        ForEach(SiteSection.allCases) { page in
                            SidebarRow(
                                label: page.label,
                                isActive: isSite && section == page,
                                level: 0,
                                trailing: page == .dashboard ? online(site.id).map { "\($0) online" } : count(site.id, page).map { $0.formatted() }
                            ) {
                                if page == .dashboard {
                                    favicon(site.id, size: 16)
                                } else {
                                    Image(systemName: page.symbol).font(.callout).foregroundStyle(.secondary).frame(width: 16)
                                }
                            } action: { go(.site(site.id), page) }
                        }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.top, topInset)
                .padding(.bottom, 16)
            }
            .frame(width: 236)

            pane
                .padding(.top, topInset)
                .padding([.trailing, .bottom], inset)
        }
    }

    // MARK: E — pages are the tabs

    private var pageFirstLayout: some View {
        VStack(spacing: 0) {
            HStack(spacing: PeekLayout.tabSpacing) {
                Pill(title: "Overview", isActive: workspace.activeTabID == .overview) {
                    Image(systemName: "globe").font(.callout).foregroundStyle(.secondary)
                } action: { go(.overview) }

                ForEach(SiteSection.allCases) { page in
                    let isActive = activeSiteID.map { workspace.state(for: $0).section == page } ?? false
                    Pill(title: page.label, isActive: isActive) {
                        Image(systemName: page.symbol).font(.callout).foregroundStyle(.secondary)
                    } action: {
                        // From the overview, the page opens on the site you were last on.
                        let siteID = activeSiteID ?? workspace.recency.compactMap { tab -> Site.ID? in
                            if case .site(let id) = tab { return id } else { return nil }
                        }.first ?? model.sites.first?.id
                        if let siteID { go(.site(siteID), page) }
                    }
                }

                Spacer()

                // The site: a favicon switch, the way a browser shows profiles.
                HStack(spacing: 6) {
                    ForEach(model.sites) { site in
                        let isActive = activeSiteID == site.id
                        Button {
                            let page = activeSiteID.map { workspace.state(for: $0).section } ?? .dashboard
                            go(.site(site.id), page)
                        } label: {
                            favicon(site.id, size: 18, radius: 5)
                                .padding(5)
                                .background(.primary.opacity(isActive ? 0.12 : 0), in: .rect(cornerRadius: 7))
                                .overlay(alignment: .bottom) {
                                    Headband().fill(Palette.acid).frame(width: 12, height: 3).offset(y: 3).opacity(isActive ? 1 : 0)
                                }
                        }
                        .buttonStyle(.plain)
                        .help(site.name)
                    }
                }
                .padding(.trailing, PeekLayout.tabTrailingInset)
            }
            .padding(.leading, chrome.tabsLeadingX)
            .frame(height: topInset)

            pane
                .padding([.horizontal, .bottom], inset)
        }
    }

    // MARK: F — Miller columns

    private var columnsLayout: some View {
        HStack(spacing: 0) {
            // Sites.
            VStack(alignment: .leading, spacing: 2) {
                columnTitle("Sites")
                SidebarRow(label: "Overview", isActive: workspace.activeTabID == .overview, level: 0, trailing: nil, chevron: false) {
                    Image(systemName: "globe").font(.callout).foregroundStyle(.secondary).frame(width: 18)
                } action: { go(.overview) }
                ForEach(model.sites) { site in
                    SidebarRow(label: site.name, isActive: activeSiteID == site.id, level: 0, trailing: online(site.id), chevron: true) {
                        favicon(site.id, size: 16)
                    } action: { go(.site(site.id), workspace.state(for: site.id).section) }
                }
                Spacer()
            }
            .padding(.horizontal, 8)
            .padding(.top, topInset)
            .frame(width: 210)

            Rectangle().fill(Palette.line).frame(width: 1).padding(.vertical, topInset)

            // Pages of the chosen site.
            VStack(alignment: .leading, spacing: 2) {
                columnTitle("Pages")
                if let siteID = activeSiteID {
                    let section = workspace.state(for: siteID).section
                    ForEach(SiteSection.allCases) { page in
                        SidebarRow(label: page.label, isActive: section == page, level: 0, trailing: count(siteID, page).map { $0.formatted() }, chevron: false) {
                            Image(systemName: page.symbol).font(.callout).foregroundStyle(.secondary).frame(width: 18)
                        } action: { go(.site(siteID), page) }
                    }
                } else {
                    Text("Choose a site")
                        .font(.callout)
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 12)
                        .padding(.top, 6)
                }
                Spacer()
            }
            .padding(.horizontal, 8)
            .padding(.top, topInset)
            .frame(width: 180)

            pane
                .padding(.top, topInset)
                .padding([.trailing, .bottom], inset)
        }
    }

    private func columnTitle(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .tracking(0.4)
            .textCase(.uppercase)
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 6)
    }

    // MARK: G — breadcrumb menus

    private var breadcrumbLayout: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                // Where you are, as menus: each crumb opens the list of its siblings.
                Menu {
                    Button("Overview") { go(.overview) }
                    Divider()
                    ForEach(model.sites) { site in
                        Button(site.name) { go(.site(site.id), workspace.state(for: site.id).section) }
                    }
                } label: {
                    Crumb(title: activeOverview?.site.name ?? "Overview") {
                        if let siteID = activeSiteID { favicon(siteID, size: 16) } else { Image(systemName: "globe").font(.callout).foregroundStyle(.secondary) }
                    }
                }
                .menuStyle(.button)
                .buttonStyle(.plain)

                if let siteID = activeSiteID {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                    Menu {
                        ForEach(SiteSection.allCases) { page in
                            Button(page.label) { go(.site(siteID), page) }
                        }
                    } label: {
                        Crumb(title: workspace.state(for: siteID).section.label) {
                            Image(systemName: workspace.state(for: siteID).section.symbol).font(.callout).foregroundStyle(.secondary)
                        }
                    }
                    .menuStyle(.button)
                    .buttonStyle(.plain)
                }

                Spacer()

                Button {
                    paletteShown = true
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "magnifyingglass")
                        Text("Jump to…")
                        Text("⌘K")
                            .font(.caption)
                            .padding(.horizontal, 5)
                            .frame(height: 18)
                            .background(.primary.opacity(0.1), in: .rect(cornerRadius: 4))
                    }
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .frame(height: 28)
                    .background(Palette.panel, in: .rect(cornerRadius: 7))
                    .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Palette.line))
                }
                .buttonStyle(.plain)
                .padding(.trailing, PeekLayout.tabTrailingInset)
            }
            .padding(.leading, chrome.tabsLeadingX)
            .frame(height: topInset)

            pane
                .padding([.horizontal, .bottom], inset)
        }
    }

    // MARK: K — icon rail

    private var railLayout: some View {
        HStack(spacing: 0) {
            VStack(spacing: 8) {
                RailIcon(isActive: workspace.activeTabID == .overview, help: "Overview") {
                    Image(systemName: "globe").font(.title3).foregroundStyle(.secondary)
                } action: { go(.overview) }

                ForEach(model.sites) { site in
                    RailIcon(isActive: activeSiteID == site.id, help: site.name) {
                        favicon(site.id, size: 24, radius: 6)
                    } action: { go(.site(site.id), workspace.state(for: site.id).section) }
                }

                if let siteID = activeSiteID {
                    Rectangle().fill(Palette.line).frame(width: 28, height: 1).padding(.vertical, 8)
                    let section = workspace.state(for: siteID).section
                    ForEach(SiteSection.allCases) { page in
                        RailIcon(isActive: section == page, help: page.label) {
                            Image(systemName: page.symbol)
                                .font(.title3)
                                .foregroundStyle(section == page ? .primary : .secondary)
                        } action: { go(.site(siteID), page) }
                    }
                }
                Spacer()
            }
            .padding(.top, topInset + 4)
            .frame(width: 68)

            pane
                .padding(.top, topInset)
                .padding([.trailing, .bottom], inset)
        }
    }

    // MARK: L — one header row

    private var twoAxisLayout: some View {
        VStack(spacing: 0) {
            HStack(spacing: 24) {
                // Sites on the left, as words with their favicons…
                HStack(spacing: 16) {
                    axisWord("Overview", isActive: workspace.activeTabID == .overview) { go(.overview) }
                    ForEach(model.sites) { site in
                        axisWord(site.name, isActive: activeSiteID == site.id, icon: site.id) {
                            go(.site(site.id), workspace.state(for: site.id).section)
                        }
                    }
                }

                Spacer()

                // …the period and the pages on the right. On the overview there is neither.
                if let siteID = activeSiteID, let overview = activeOverview {
                    @Bindable var state = workspace.state(for: siteID)
                    if state.section == .dashboard {
                        WordSwitch(options: Period.allCases, selection: $state.period, label: \.label)
                    }
                    WordSwitch(options: SiteSection.allCases, selection: $state.section, label: \.label)
                    PrototypeRefreshButton(refreshing: refreshing) { actions.refresh(.site(overview.id)) }
                }
            }
            .padding(.leading, chrome.tabsLeadingX)
            .padding(.trailing, PeekLayout.tabTrailingInset + 6)
            .frame(height: topInset)

            pane
                .padding([.horizontal, .bottom], inset)
        }
    }

    private func axisWord(_ title: String, isActive: Bool, icon: Site.ID? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 7) {
                if let icon { favicon(icon, size: 14) }
                Text(title)
                    .font(.callout.weight(isActive ? .semibold : .regular))
                    .foregroundStyle(isActive ? .primary : .secondary)
            }
            .padding(.bottom, 4)
            .overlay(alignment: .bottom) {
                Headband().fill(Palette.acid).frame(height: 3).opacity(isActive ? 1 : 0)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Pieces

private struct SidebarRow<Icon: View>: View {
    let label: String
    let isActive: Bool
    let level: Int
    let trailing: String?
    var chevron = false
    @ViewBuilder let icon: () -> Icon
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                icon()
                Text(label)
                    .font(.callout.weight(isActive ? .semibold : .regular))
                    .foregroundStyle(isActive ? .primary : .secondary)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let trailing {
                    Text(trailing)
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                }
                if chevron {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.tertiary)
                } else {
                    HeadbandMarker(isActive: isActive)
                }
            }
            .padding(.leading, 10 + CGFloat(level) * 18)
            .padding(.trailing, 10)
            .frame(height: 28)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(isActive ? Palette.raised : .primary.opacity(isHovering ? 0.05 : 0))
            )
            .overlay {
                if isActive {
                    RoundedRectangle(cornerRadius: 6).strokeBorder(Palette.line)
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
    }
}

/// A title-bar pill, as the tab bar draws them, for shells that put something else in them.
private struct Pill<Icon: View>: View {
    let title: String
    let isActive: Bool
    @ViewBuilder let icon: () -> Icon
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                icon().frame(width: PeekLayout.tabIconSize, height: PeekLayout.tabIconSize)
                Text(title).font(.callout).lineLimit(1)
                Spacer(minLength: 0)
                HeadbandMarker(isActive: isActive)
            }
            .padding(.horizontal, 10)
            .frame(width: 150, height: 28)
            .background(isActive ? Palette.panel : Palette.raised.opacity(0.6), in: .rect(cornerRadius: PeekLayout.cardCornerRadius))
            .overlay(RoundedRectangle(cornerRadius: PeekLayout.cardCornerRadius).strokeBorder(Palette.line))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

private struct Crumb<Icon: View>: View {
    let title: String
    @ViewBuilder let icon: () -> Icon

    var body: some View {
        HStack(spacing: 7) {
            icon().frame(width: 16, height: 16)
            Text(title).font(.callout.weight(.medium))
            Image(systemName: "chevron.down")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 10)
        .frame(height: 28)
        .background(Palette.panel, in: .rect(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Palette.line))
    }
}

private struct RailIcon<Icon: View>: View {
    let isActive: Bool
    let help: String
    @ViewBuilder let icon: () -> Icon
    let action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            icon()
                .frame(width: 40, height: 40)
                .background(
                    RoundedRectangle(cornerRadius: 10)
                        .fill(isActive ? Palette.raised : .primary.opacity(isHovering ? 0.06 : 0))
                )
                .overlay {
                    if isActive { RoundedRectangle(cornerRadius: 10).strokeBorder(Palette.line) }
                }
                .overlay(alignment: .leading) {
                    // The headband stands beside the active icon, on the rail's edge.
                    Headband().fill(Palette.acid).frame(width: 4, height: 14).offset(x: -12).opacity(isActive ? 1 : 0)
                }
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .help(help)
    }
}

/// ⌘K: type a site or a page, Return opens the first match.
private struct JumpPalette: View {
    struct Entry: Identifiable {
        let title: String
        let detail: String
        let tab: TabID
        let section: SiteSection?
        var id: String { "\(title) \(detail)" }
    }

    let entries: [Entry]
    let dismiss: () -> Void
    let choose: (Entry) -> Void

    @State private var query = ""
    @FocusState private var focused: Bool

    private var matches: [Entry] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return Array(entries.prefix(9)) }
        return Array(entries.filter { $0.id.lowercased().contains(needle) }.prefix(9))
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Site or page…", text: $query)
                    .textFieldStyle(.plain)
                    .font(.title3)
                    .focused($focused)
                    .onSubmit { if let first = matches.first { choose(first) } }
            }
            .padding(14)
            Rectangle().fill(Palette.line).frame(height: 1)
            VStack(spacing: 2) {
                ForEach(Array(matches.enumerated()), id: \.element.id) { index, entry in
                    Button { choose(entry) } label: {
                        HStack {
                            Text(entry.title).font(.callout.weight(.medium))
                            Text(entry.detail).font(.callout).foregroundStyle(.secondary)
                            Spacer()
                            if index == 0 {
                                Text("↩").font(.caption).foregroundStyle(.tertiary)
                            }
                        }
                        .padding(.horizontal, 12)
                        .frame(height: 30)
                        .background(index == 0 ? Palette.panel : .clear, in: .rect(cornerRadius: 6))
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(8)
        }
        .frame(width: 460)
        .background(Palette.raised, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.line))
        .shadow(color: .black.opacity(0.4), radius: 24, y: 10)
        .onAppear { focused = true }
        .background {
            Button("Close") { dismiss() }
                .keyboardShortcut(.cancelAction)
                .opacity(0)
                .frame(width: 0, height: 0)
        }
    }
}
