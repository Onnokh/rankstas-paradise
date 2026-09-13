import SwiftUI

// The pieces a settings page is built from: a header, sections opened by a rule, and rows
// with the words on the left and one control on the right. The same three shapes make every
// page, so the window reads as one thing however many pages it grows.

/// The measures every settings page shares.
enum SettingsLayout {
    /// The page's reading column. Wider than this and a row's words drift from its control.
    static let columnWidth: CGFloat = 640
    static let columnInset: CGFloat = 40
    /// The zone a row's control stands in. Fixed, so controls line up down the page.
    static let controlWidth: CGFloat = 240
    static let controlRadius: CGFloat = 6
    static let sidebarWidth: CGFloat = 232
}

// MARK: - Search

/// The sidebar's search text, read by every row on the open page: a row that does not carry
/// the words steps aside, and a section with no rows left goes with them.
struct SettingsQueryKey: EnvironmentKey {
    static let defaultValue = ""
}

extension EnvironmentValues {
    var settingsQuery: String {
        get { self[SettingsQueryKey.self] }
        set { self[SettingsQueryKey.self] = newValue }
    }
}

/// How many rows a section still shows. Rows report one each; the section reads the sum.
struct SettingsVisibleRowsKey: PreferenceKey {
    static let defaultValue = 0
    static func reduce(value: inout Int, nextValue: () -> Int) {
        value += nextValue()
    }
}

// MARK: - Header

/// The page's name and one line on what it holds. Anything trailing — a Save button — stands
/// on the header's right, at the control zone's edge.
struct SettingsPageHeader<Trailing: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder let trailing: Trailing

    init(_ title: String, subtitle: String, @ViewBuilder trailing: () -> Trailing = { EmptyView() }) {
        self.title = title
        self.subtitle = subtitle
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 24) {
            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                    .font(.system(size: 28, weight: .bold))
                Text(subtitle)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            trailing
        }
        .padding(.bottom, 8)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Section

/// A group of rows under one heading, opened by a hairline the way the guide opens a section.
struct SettingsSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    @Environment(\.settingsQuery) private var query
    @State private var visibleRows = 0

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    /// Hidden only while a search is on and no row of this section carries the words. With
    /// no search every section stands, rows or not, so a page never changes shape at rest.
    private var isHidden: Bool {
        !query.trimmingCharacters(in: .whitespaces).isEmpty && visibleRows == 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !isHidden {
                Text(title)
                    .font(.system(size: 17, weight: .semibold))
                    .padding(.bottom, 10)
                Rectangle()
                    .fill(Palette.line)
                    .frame(height: 1)
                    .padding(.bottom, 6)
            }
            content
                .onPreferenceChange(SettingsVisibleRowsKey.self) { visibleRows = $0 }
        }
        .padding(.top, isHidden ? 0 : 32)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }
}

// MARK: - Row

/// One setting: what it is and what it does on the left, the control on the right. Every
/// row is the same height and its control stands in the same zone, so a page reads as a
/// ledger and not as a form.
struct SettingsRow<Control: View>: View {
    let title: String
    let detail: String?
    @ViewBuilder let control: Control

    @Environment(\.settingsQuery) private var query

    init(_ title: String, detail: String? = nil, @ViewBuilder control: () -> Control) {
        self.title = title
        self.detail = detail
        self.control = control()
    }

    private var matches: Bool {
        let needle = query.trimmingCharacters(in: .whitespaces)
        return needle.isEmpty
            || title.localizedCaseInsensitiveContains(needle)
            || detail?.localizedCaseInsensitiveContains(needle) == true
    }

    var body: some View {
        if matches {
            HStack(alignment: .center, spacing: 24) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.system(size: 14))
                    if let detail {
                        Text(detail)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                control
                    .frame(width: SettingsLayout.controlWidth, alignment: .trailing)
            }
            .frame(minHeight: 44)
            .padding(.vertical, 8)
            .preference(key: SettingsVisibleRowsKey.self, value: 1)
            .accessibilityElement(children: .contain)
        }
    }
}

// MARK: - Field

/// The guide's field: void behind the text, a hairline around it, blue when it has focus.
/// The label is spoken, not shown — the row's title is the visible one.
struct SettingsField: View {
    let label: String
    @Binding var text: String
    var prompt: String = ""
    var isSecure = false

    @FocusState private var isFocused: Bool

    var body: some View {
        Group {
            if isSecure {
                SecureField(label, text: $text, prompt: Text(prompt))
            } else {
                TextField(label, text: $text, prompt: Text(prompt))
            }
        }
        .textFieldStyle(.plain)
        .labelsHidden()
        .focused($isFocused)
        .padding(.horizontal, 10)
        .frame(height: 28)
        .background(Palette.raised, in: .rect(cornerRadius: SettingsLayout.controlRadius))
        .overlay(
            RoundedRectangle(cornerRadius: SettingsLayout.controlRadius)
                .strokeBorder(isFocused ? Palette.blue : Palette.line)
        )
        .animation(.easeOut(duration: 0.16), value: isFocused)
    }
}

/// A value the page shows and does not edit, set where a control would be.
struct SettingsValue: View {
    let text: String
    var isMonospaced = false

    var body: some View {
        Text(text)
            .font(isMonospaced ? .callout.monospaced() : .callout)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.trailing)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .trailing)
    }
}
