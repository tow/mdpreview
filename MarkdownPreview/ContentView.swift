import SwiftUI

@MainActor
final class AppState: ObservableObject {
    @Published var rootNodes: [FileNode] = []
    @Published var rootDirectoryName: String = ""
    @Published var selectedFile: URL? {
        didSet { onSelectionChanged() }
    }
    @Published var markdownContent: String = ""
    @Published var exportPDFTrigger: Int = 0
    @Published var viewPDFTrigger: Int = 0
    @Published var currentTheme: Theme = Theme.all[0]
    @Published var showSearch: Bool = false
    @Published var searchText: String = ""
    @Published var searchForwardTrigger: Int = 0
    @Published var searchBackwardTrigger: Int = 0
    @Published var viewMode: ViewMode = .reading
    @Published var viewModeTrigger: Int = 0
    @Published var pdfConfig: PDFConfig = PDFConfig.load()

    func exportPDF() { exportPDFTrigger += 1 }
    func viewPDF() { viewPDFTrigger += 1 }
    func findNext() { searchForwardTrigger += 1 }
    func findPrevious() { searchBackwardTrigger += 1 }

    func toggleViewMode() {
        viewMode = viewMode == .reading ? .document : .reading
        if viewMode == .document {
            // Re-read config so edits take effect immediately
            pdfConfig = PDFConfig.load()
        }
        viewModeTrigger += 1
    }

    var resolvedPDFConfigJSON: String {
        let title = selectedFile?.deletingPathExtension().lastPathComponent ?? "Untitled"
        let formatter = DateFormatter()
        formatter.dateStyle = .long
        let date = formatter.string(from: Date())
        return pdfConfig.resolvedJSON(title: title, date: date)
    }

    private let watcher = FileWatcher()
    private let defaultRootURL = URL(fileURLWithPath:
        ProcessInfo.processInfo.environment["MDPREVIEW_ROOT"]
            ?? FileManager.default.homeDirectoryForCurrentUser.path
    )

    init() {
        rootDirectoryName = defaultRootURL.lastPathComponent
        rootNodes = FileNode.loadChildren(of: defaultRootURL)
        watcher.onChange = { [weak self] in
            self?.reloadCurrentFile()
        }
        NotificationCenter.default.addObserver(
            forName: .openMarkdownFile, object: nil, queue: .main
        ) { [weak self] note in
            if let url = note.object as? URL {
                self?.openFile(url)
            }
        }
        NotificationCenter.default.addObserver(forName: .showSearch, object: nil, queue: .main) { [weak self] _ in
            self?.showSearch = true
        }
        // Pick up a file passed at launch. Deferred so didSet fires after init completes.
        if let delegate = NSApp.delegate as? AppDelegate, let url = delegate.pendingURL {
            delegate.pendingURL = nil
            DispatchQueue.main.async { self.openFile(url) }
        }
    }

    func openFile(_ url: URL) {
        let dir = url.deletingLastPathComponent()
        rootDirectoryName = dir.lastPathComponent
        rootNodes = FileNode.loadChildren(of: dir)
        selectedFile = url
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
            FileTreeView(nodes: state.rootNodes, selectedFile: $state.selectedFile, directoryName: state.rootDirectoryName)
                .navigationSplitViewColumnWidth(min: 200, ideal: 260, max: 400)
        } detail: {
            if state.selectedFile != nil {
                ZStack(alignment: .bottom) {
                    MarkdownWebView(
                        markdownContent: state.markdownContent,
                        exportTrigger: state.exportPDFTrigger,
                        viewPDFTrigger: state.viewPDFTrigger,
                        exportFilename: state.selectedFile?.deletingPathExtension().lastPathComponent ?? "document",
                        theme: state.currentTheme,
                        searchText: state.searchText,
                        searchForwardTrigger: state.searchForwardTrigger,
                        searchBackwardTrigger: state.searchBackwardTrigger,
                        viewMode: state.viewMode,
                        pdfConfigJSON: state.resolvedPDFConfigJSON,
                        viewModeTrigger: state.viewModeTrigger,
                        baseURL: state.selectedFile?.deletingLastPathComponent()
                    )
                    if state.showSearch {
                        SearchBar(
                            text: $state.searchText,
                            onNext: state.findNext,
                            onPrevious: state.findPrevious,
                            onClose: {
                                state.showSearch = false
                                state.searchText = ""
                            }
                        )
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                }
                .animation(.easeInOut(duration: 0.15), value: state.showSearch)
                .toolbar(id: "main") {
                    ToolbarItem(id: "mode") {
                        Picker("Mode", selection: Binding(
                            get: { state.viewMode },
                            set: { newMode in
                                state.viewMode = newMode
                                if newMode == .document {
                                    state.pdfConfig = PDFConfig.load()
                                }
                                state.viewModeTrigger += 1
                            }
                        )) {
                            ForEach(ViewMode.allCases) { mode in
                                Label(mode.label, systemImage: mode.icon).tag(mode)
                            }
                        }
                        .pickerStyle(.segmented)
                        .help("Switch between Reading and Document mode")
                    }
                    ToolbarItem(id: "search") {
                        Button {
                            withAnimation { state.showSearch.toggle() }
                            if !state.showSearch { state.searchText = "" }
                        } label: {
                            Label("Find", systemImage: "magnifyingglass")
                        }
                    }
                    ToolbarItem(id: "theme") {
                        Picker("Theme", selection: $state.currentTheme) {
                            ForEach(Theme.all) { theme in
                                Text(theme.name).tag(theme)
                            }
                        }
                        .pickerStyle(.menu)
                        .help("Switch theme")
                    }
                    ToolbarItem(id: "viewpdf") {
                        Button {
                            state.viewPDF()
                        } label: {
                            Label("View PDF", systemImage: "eye.fill")
                        }
                        .opacity(state.viewMode == .document ? 1 : 0)
                        .disabled(state.viewMode != .document)
                    }
                    ToolbarItem(id: "savepdf") {
                        Button {
                            state.exportPDF()
                        } label: {
                            Label("Save PDF", systemImage: "arrow.down.doc")
                        }
                        .opacity(state.viewMode == .document ? 1 : 0)
                        .disabled(state.viewMode != .document)
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
