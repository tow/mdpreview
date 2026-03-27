import AppKit

class AppDelegate: NSObject, NSApplicationDelegate {
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first(where: { $0.pathExtension.lowercased() == "md" }) else { return }
        // Bring window to front
        application.windows.first?.makeKeyAndOrderFront(nil)
        NotificationCenter.default.post(name: .openMarkdownFile, object: url)
    }
}

extension Notification.Name {
    static let openMarkdownFile = Notification.Name("openMarkdownFile")
}
