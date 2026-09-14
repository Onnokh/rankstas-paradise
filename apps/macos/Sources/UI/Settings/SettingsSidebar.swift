import SwiftUI

/// What the window can show: the account's pages, then one page per site.
enum SettingsPage: Hashable {
    case server
    case keys
    case site(Site.ID)
}

/// The column on the window's left: a search field, then the pages in groups — the account,
/// the sites, the vendors. Each page is an icon and a word; a site wears its favicon. The
/// open page sits on a lighter surface with the headband in the gap beside it, the way the
/// rail marks the active screen.
struct SettingsSidebar: View {
    let model: SettingsModel
    let favicons: FaviconStore
    @Binding var page: SettingsPage
    @Binding var query: String

    /// Room for the traffic lights: the window has no title bar, so the sidebar starts under them.
    static let topInset: CGFloat = 52

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            SettingsSearchField(text: $query)

            group("Account") {
                item(accountName, symbol: "person.crop.circle", .server)
            }

            group("Sites") {
                if model.sites.isEmpty {
                    Text(model.isLoading ? "Loading…" : "None")
                        .font(.body)
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 10)
                        .frame(height: 32)
                } else {
                    ForEach(model.sites) { site in
                        item(site.name, icon: favicons.image(for: site.id), symbol: "globe", .site(site.id))
                    }
                }
            }

            group("Vendors") {
                item("Keys", symbol: "key", .keys)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, PeekLayout.contentInset)
        .padding(.top, Self.topInset)
        .padding(.bottom, 16)
        .frame(width: SettingsLayout.sidebarWidth, alignment: .topLeading)
        .background(Palette.void)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Settings pages")
    }

    /// The account is the server the app is signed in to, by its host.
    private var accountName: String {
        model.target?.baseURL?.host() ?? "Not signed in"
    }

    private func matches(_ title: String) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespaces)
        return needle.isEmpty || title.localizedCaseInsensitiveContains(needle)
    }

    @ViewBuilder
    private func group<Items: View>(_ title: String, @ViewBuilder items: () -> Items) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10)
                .padding(.bottom, 4)
            items()
        }
    }

    @ViewBuilder
    private func item(_ title: String, icon: Image? = nil, symbol: String, _ target: SettingsPage) -> some View {
        if matches(title) {
            SettingsSidebarItem(title: title, icon: icon, symbol: symbol, isActive: page == target) { page = target }
        }
    }
}

/// The field at the sidebar's top. It narrows the pages below it and the rows on the open page.
private struct SettingsSearchField: View {
    @Binding var text: String
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.secondary)
            TextField("Search settings", text: $text)
                .textFieldStyle(.plain)
                .focused($isFocused)
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 32)
        .background(Palette.raised, in: .rect(cornerRadius: SettingsLayout.controlRadius))
        .overlay(
            RoundedRectangle(cornerRadius: SettingsLayout.controlRadius)
                .strokeBorder(isFocused ? Palette.blue : Palette.line)
        )
        .animation(.easeOut(duration: 0.16), value: isFocused)
    }
}

private struct SettingsSidebarItem: View {
    let title: String
    let icon: Image?
    let symbol: String
    let isActive: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Group {
                    if let icon {
                        icon
                            .resizable()
                            .interpolation(.high)
                            .scaledToFit()
                            .clipShape(.rect(cornerRadius: 3))
                    } else {
                        Image(systemName: symbol)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(isActive ? .primary : .secondary)
                    }
                }
                .frame(width: 18, height: 18)
                Text(title)
                    .font(.body.weight(isActive ? .medium : .regular))
                    .foregroundStyle(isActive ? .primary : .secondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, 10)
            .frame(height: 32)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: SettingsLayout.controlRadius)
                    .fill(isActive ? Palette.selected : .clear)
            )
            // The headband stands in the gap between the window edge and the row, the
            // way it marks the active row in the guide's nav and in the rail.
            .overlay(alignment: .leading) {
                UprightHeadband()
                    .offset(x: -(PeekLayout.contentInset + Headband.markerSize.height) / 2)
                    .opacity(isActive ? 1 : 0)
            }
            .contentShape(.rect)
        }
        .clickableSurface(cornerRadius: SettingsLayout.controlRadius)
        .accessibilityAddTraits(isActive ? .isSelected : [])
        .animation(.snappy(duration: 0.2), value: isActive)
    }
}
