import AppKit

class AppDelegate: NSObject, NSApplicationDelegate {
    /// Parked when the app is launched by opening a file and AppState isn't ready yet.
    var pendingURL: URL?

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first(where: { $0.pathExtension.lowercased() == "md" }) else { return }
        application.windows.first?.makeKeyAndOrderFront(nil)
        pendingURL = url
        NotificationCenter.default.post(name: .openMarkdownFile, object: url)
    }
}

extension Notification.Name {
    static let openMarkdownFile = Notification.Name("openMarkdownFile")
}
