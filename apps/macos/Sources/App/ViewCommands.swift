import SwiftUI

/// The window's refresh action, published to the menu bar. Nil while no window is key, which
/// is what disables the menu item.
struct RefreshActionKey: FocusedValueKey {
    typealias Value = @MainActor () -> Void
}

extension FocusedValues {
    var refresh: RefreshActionKey.Value? {
        get { self[RefreshActionKey.self] }
        set { self[RefreshActionKey.self] = newValue }
    }
}

/// The app's additions to the View menu. A menu item is where a Mac user looks a shortcut up,
/// so ⌘R lives here rather than on a hidden button.
struct ViewCommands: Commands {
    @FocusedValue(\.refresh) private var refresh

    var body: some Commands {
        CommandGroup(before: .toolbar) {
            Button("Refresh") { refresh?() }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(refresh == nil)
        }
    }
}
