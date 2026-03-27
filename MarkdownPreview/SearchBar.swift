import SwiftUI

struct SearchBar: View {
    @Binding var text: String
    @FocusState private var focused: Bool
    var onNext: () -> Void
    var onPrevious: () -> Void
    var onClose: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)

            TextField("Find", text: $text)
                .textFieldStyle(.plain)
                .focused($focused)
                .frame(minWidth: 160)
                .onKeyPress(keys: [.return, .upArrow, .downArrow]) { press in
                    let backward = press.key == .upArrow ||
                        (press.key == .return && press.modifiers.contains(.shift))
                    if backward { onPrevious() } else { onNext() }
                    return .handled
                }

            if !text.isEmpty {
                Button(action: onPrevious) {
                    Image(systemName: "chevron.up")
                }
                .buttonStyle(.plain)
                .help("Previous match (⇧↩ or ↑)")

                Button(action: onNext) {
                    Image(systemName: "chevron.down")
                }
                .buttonStyle(.plain)
                .help("Next match (↩ or ↓)")
            }

            Button(action: onClose) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("Close (⎋)")
            .keyboardShortcut(.escape, modifiers: [])
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
        .shadow(color: .black.opacity(0.15), radius: 8, y: 2)
        .padding(12)
        .onAppear { focused = true }
    }
}
