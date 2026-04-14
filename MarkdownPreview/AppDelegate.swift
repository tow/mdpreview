import AppKit

class AppDelegate: NSObject, NSApplicationDelegate {
    static private(set) weak var shared: AppDelegate?
    private var pendingURLs: [URL] = []

    override init() {
        super.init()
        AppDelegate.shared = self
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        // SwiftUI's @NSApplicationDelegateAdaptor wraps our delegate and
        // swallows kAEOpenDocuments on macOS, so we install our own handler.
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleOpenDocs(_:withReplyEvent:)),
            forEventClass: AEEventClass(kCoreEventClass),
            andEventID: AEEventID(kAEOpenDocuments)
        )
    }

    @objc func handleOpenDocs(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        guard let docList = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject)) else { return }
        for i in 1...docList.numberOfItems {
            guard let item = docList.atIndex(i),
                  let urlStr = item.stringValue,
                  let url = URL(string: urlStr) else { continue }
            if ["md", "markdown"].contains(url.pathExtension.lowercased()) {
                pendingURLs.append(url)
            }
        }
        NotificationCenter.default.post(name: .processFileQueue, object: nil)
    }

    func claimNextURL() -> URL? {
        pendingURLs.isEmpty ? nil : pendingURLs.removeFirst()
    }

    var remainingURLCount: Int { pendingURLs.count }
}

extension Notification.Name {
    static let processFileQueue = Notification.Name("processFileQueue")
    static let showSearch = Notification.Name("showSearch")
    static let printDocument = Notification.Name("printDocument")
}
