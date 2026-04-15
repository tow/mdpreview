import AppKit
import SwiftUI
import UniformTypeIdentifiers

class AppDelegate: NSObject, NSApplicationDelegate {
    private var pendingURLs: [URL] = []
    private var fileWindows: [NSWindow] = []

    func applicationWillFinishLaunching(_ notification: Notification) {
        // SwiftUI's @NSApplicationDelegateAdaptor does not deliver
        // application(_:open:) for kAEOpenDocuments events, so install our
        // own Apple Event handler.
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleOpenDocs(_:withReplyEvent:)),
            forEventClass: AEEventClass(kCoreEventClass),
            andEventID: AEEventID(kAEOpenDocuments)
        )
        claimDefaultMarkdownHandler()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        flushPendingURLs()
    }

    @objc func handleOpenDocs(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        guard let docList = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject)) else { return }
        for i in 1...docList.numberOfItems {
            guard let item = docList.atIndex(i),
                  let coerced = item.coerce(toDescriptorType: DescType(typeFileURL)),
                  let url = URL(dataRepresentation: coerced.data, relativeTo: nil) else { continue }
            if ["md", "markdown"].contains(url.pathExtension.lowercased()) {
                pendingURLs.append(url)
            }
        }
        flushPendingURLs()
    }

    // WindowGroup does not auto-create a window when the app is launched via a
    // file-open Apple Event, so we create one per URL ourselves.
    private func flushPendingURLs() {
        while !pendingURLs.isEmpty {
            presentWindow(for: pendingURLs.removeFirst())
        }
    }

    private func presentWindow(for url: URL) {
        let hosting = NSHostingController(rootView: ContentView(initialURL: url))
        let window = NSWindow(contentViewController: hosting)
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.setContentSize(NSSize(width: 1200, height: 800))
        window.title = url.lastPathComponent
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        fileWindows.append(window)
    }

    private func claimDefaultMarkdownHandler() {
        guard let bundleID = Bundle.main.bundleIdentifier else { return }
        for ext in ["md", "markdown"] {
            guard let uti = UTType(filenameExtension: ext)?.identifier else { continue }
            let current = LSCopyDefaultRoleHandlerForContentType(uti as CFString, .viewer)?.takeRetainedValue() as String?
            if current != bundleID {
                LSSetDefaultRoleHandlerForContentType(uti as CFString, .viewer, bundleID as CFString)
            }
        }
    }
}

extension Notification.Name {
    static let showSearch = Notification.Name("showSearch")
    static let printDocument = Notification.Name("printDocument")
}
