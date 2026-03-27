import SwiftUI

@MainActor
final class AppState: ObservableObject {
    @Published var rootNodes: [FileNode] = []
    @Published var selectedFile: URL? {
        didSet { onSelectionChanged() }
    }
    @Published var markdownContent: String = ""
    @Published var exportPDFTrigger: Int = 0
    @Published var viewPDFTrigger: Int = 0
    @Published var currentTheme: Theme = Theme.all[0]

    func exportPDF() { exportPDFTrigger += 1 }
    func viewPDF() { viewPDFTrigger += 1 }

    private let watcher = FileWatcher()
    private let rootURL = URL(fileURLWithPath:
        ProcessInfo.processInfo.environment["MDPREVIEW_ROOT"]
            ?? FileManager.default.homeDirectoryForCurrentUser.path
    )

    init() {
        rootNodes = FileNode.loadChildren(of: rootURL)
        watcher.onChange = { [weak self] in
            self?.reloadCurrentFile()
        }
        NotificationCenter.default.addObserver(
            forName: .openMarkdownFile, object: nil, queue: .main
        ) { [weak self] note in
            self?.selectedFile = note.object as? URL
        }
        // Pick up a file passed at launch. Deferred so didSet fires after init completes.
        if let delegate = NSApp.delegate as? AppDelegate, let url = delegate.pendingURL {
            delegate.pendingURL = nil
            DispatchQueue.main.async { self.selectedFile = url }
        }
    }

    private func onSelectionChanged() {
        reloadCurrentFile()
        if let url = selectedFile {
            watcher.watch(url: url)
        } else {
            watcher.stop()
        }
    }

    private func reloadCurrentFile() {
        guard let url = selectedFile,
              let content = try? String(contentsOf: url, encoding: .utf8) else {
            markdownContent = ""
            return
        }
        markdownContent = content
    }
}

struct ContentView: View {
    @StateObject private var state = AppState()

    var body: some View {
        NavigationSplitView {
            FileTreeView(nodes: state.rootNodes, selectedFile: $state.selectedFile)
                .navigationSplitViewColumnWidth(min: 200, ideal: 260, max: 400)
        } detail: {
            if state.selectedFile != nil {
                MarkdownWebView(
                    markdownContent: state.markdownContent,
                    exportTrigger: state.exportPDFTrigger,
                    viewPDFTrigger: state.viewPDFTrigger,
                    exportFilename: state.selectedFile?.deletingPathExtension().lastPathComponent ?? "document",
                    theme: state.currentTheme
                )
                .toolbar {
                    ToolbarItem {
                        Picker("Theme", selection: $state.currentTheme) {
                            ForEach(Theme.all) { theme in
                                Text(theme.name).tag(theme)
                            }
                        }
                        .pickerStyle(.menu)
                        .help("Switch theme")
                    }
                    ToolbarItem {
                        Button {
                            state.viewPDF()
                        } label: {
                            Label("View PDF", systemImage: "doc.text.magnifyingglass")
                        }
                    }
                    ToolbarItem {
                        Button {
                            state.exportPDF()
                        } label: {
                            Label("Save PDF", systemImage: "arrow.down.doc")
                        }
                    }
                }
            } else {
                ContentUnavailableView(
                    "No file selected",
                    systemImage: "doc.text",
                    description: Text("Select a Markdown file from the sidebar")
                )
            }
        }
        .navigationTitle(state.selectedFile?.lastPathComponent ?? "MarkdownPreview")
    }
}
