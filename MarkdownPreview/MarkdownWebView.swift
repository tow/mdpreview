import SwiftUI
import WebKit
import PDFKit
import UniformTypeIdentifiers

struct MarkdownWebView: NSViewRepresentable {
    let markdownContent: String
    let exportTrigger: Int
    let viewPDFTrigger: Int
    var exportFilename: String = "document"
    var theme: Theme = Theme.all[0]
    var searchText: String = ""
    var searchForwardTrigger: Int = 0
    var searchBackwardTrigger: Int = 0
    var viewMode: ViewMode = .reading
    var pdfConfigJSON: String = "{}"
    var viewModeTrigger: Int = 0
    var baseURL: URL?

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        config.userContentController.add(context.coordinator, name: "paginationDone")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView

        if let resourcesURL = Bundle.main.resourceURL {
            let templateURL = resourcesURL.appendingPathComponent("template.html")
            // Grant read access to / so images referenced by relative paths in markdown files work
            let rootAccess = URL(fileURLWithPath: "/")
            webView.loadFileURL(templateURL, allowingReadAccessTo: rootAccess)
        }

        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        let coord = context.coordinator

        // View mode change
        if viewModeTrigger != coord.lastViewModeTrigger {
            coord.lastViewModeTrigger = viewModeTrigger
            coord.currentViewMode = viewMode
            coord.setViewMode(viewMode, configJSON: pdfConfigJSON)
        }

        // Base URL change (for resolving relative image paths)
        if baseURL != coord.lastBaseURL {
            coord.lastBaseURL = baseURL
            coord.updateBaseURL(baseURL)
        }

        // Content change
        coord.render(markdownContent)

        // Theme change
        if theme.id != coord.lastThemeID {
            coord.lastThemeID = theme.id
            coord.applyTheme(theme)
        }

        // Export triggers
        if exportTrigger != coord.lastExportTrigger {
            coord.lastExportTrigger = exportTrigger
            coord.exportPDF(filename: exportFilename)
        }
        if viewPDFTrigger != coord.lastViewPDFTrigger {
            coord.lastViewPDFTrigger = viewPDFTrigger
            coord.viewPDF(filename: exportFilename)
        }

        // Search triggers
        if searchForwardTrigger != coord.lastSearchForwardTrigger {
            coord.lastSearchForwardTrigger = searchForwardTrigger
            coord.find(searchText, backwards: false)
        }
        if searchBackwardTrigger != coord.lastSearchBackwardTrigger {
            coord.lastSearchBackwardTrigger = searchBackwardTrigger
            coord.find(searchText, backwards: true)
        }
        if searchText != coord.lastSearchText {
            coord.lastSearchText = searchText
            coord.find(searchText, backwards: false, newQuery: true)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        weak var webView: WKWebView?
        private var isLoaded = false
        private var pendingContent: String?
        private var lastRenderedContent: String = ""
        private var pendingTheme: Theme?
        private var pendingViewMode: (ViewMode, String)?
        private var pendingBaseURL: URL?
        var lastExportTrigger: Int = 0
        var lastViewPDFTrigger: Int = 0
        var lastSearchForwardTrigger: Int = 0
        var lastSearchBackwardTrigger: Int = 0
        var lastSearchText: String = ""
        var lastThemeID: String = ""
        var lastViewModeTrigger: Int = 0
        var lastBaseURL: URL?
        var currentViewMode: ViewMode = .reading

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            if message.name == "paginationDone" {
                // Fade in the webview now that pagination is complete
                guard let webView else { return }
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = 0.15
                    webView.animator().alphaValue = 1
                }
            }
        }

        func find(_ text: String, backwards: Bool, newQuery: Bool = false) {
            guard let webView else { return }
            guard !text.isEmpty else {
                webView.evaluateJavaScript("window.getSelection().removeAllRanges()", completionHandler: nil)
                return
            }
            guard let jsonData = try? JSONEncoder().encode(text),
                  let jsonString = String(data: jsonData, encoding: .utf8) else { return }
            let clear = newQuery ? "window.getSelection().removeAllRanges();" : ""
            let js = "\(clear)window.find(\(jsonString), false, \(backwards), true)"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func updateBaseURL(_ url: URL?) {
            if isLoaded {
                evaluateBaseURL(url)
            } else {
                pendingBaseURL = url
            }
        }

        private func evaluateBaseURL(_ url: URL?) {
            guard let webView, let url else { return }
            let baseHref = url.absoluteString
            guard let jsonData = try? JSONEncoder().encode(baseHref),
                  let jsonString = String(data: jsonData, encoding: .utf8) else { return }
            let js = "setBaseURL(\(jsonString))"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func applyTheme(_ theme: Theme) {
            if isLoaded {
                evaluateTheme(theme)
            } else {
                pendingTheme = theme
            }
        }

        private func evaluateTheme(_ theme: Theme) {
            guard let webView else { return }
            let js = "setTheme('\(theme.cssFile)', '\(theme.codeThemeFile)')"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func setViewMode(_ mode: ViewMode, configJSON: String) {
            if isLoaded {
                evaluateViewMode(mode, configJSON: configJSON)
            } else {
                pendingViewMode = (mode, configJSON)
            }
        }

        private func evaluateViewMode(_ mode: ViewMode, configJSON: String) {
            guard let webView else { return }
            // Hide webview at the native layer to prevent any flash
            webView.alphaValue = 0
            if mode == .reading {
                let js = "setViewMode('reading', null)"
                webView.evaluateJavaScript(js) { _, _ in
                    // Reading mode is synchronous — restore immediately
                    NSAnimationContext.runAnimationGroup { context in
                        context.duration = 0.15
                        webView.animator().alphaValue = 1
                    }
                }
            } else {
                // Document mode: JS will post paginationDone message when ready
                let js = "setViewMode('document', \(configJSON))"
                webView.evaluateJavaScript(js, completionHandler: nil)
            }
        }

        func exportPDF(filename: String) {
            guard let webView else { return }
            capturePagedPDF(webView: webView) { data in
                guard let data else { return }
                let panel = NSSavePanel()
                panel.allowedContentTypes = [.pdf]
                panel.nameFieldStringValue = filename + ".pdf"
                panel.canCreateDirectories = true
                if panel.runModal() == .OK, let url = panel.url {
                    try? data.write(to: url)
                }
            }
        }

        func viewPDF(filename: String) {
            guard let webView else { return }
            capturePagedPDF(webView: webView) { data in
                guard let data else { return }
                let url = FileManager.default.temporaryDirectory
                    .appendingPathComponent(filename + ".pdf")
                try? data.write(to: url)
                NSWorkspace.shared.open(url)
            }
        }

        /// Capture each Paged.js page individually and merge into one PDF
        private func capturePagedPDF(webView: WKWebView, completion: @escaping (Data?) -> Void) {
            // Get bounding rects of all .pagedjs_page elements
            let js = """
            (function(){
                var pages = document.querySelectorAll('.pagedjs_page');
                if (!pages.length) return null;
                // Remove visual gaps for clean capture
                var container = document.querySelector('.pagedjs_pages');
                if (container) container.style.padding = '0';
                pages.forEach(function(p){ p.style.marginBottom = '0'; p.style.boxShadow = 'none'; });
                var rects = [];
                pages.forEach(function(p){
                    var r = p.getBoundingClientRect();
                    rects.push({x: r.x, y: r.y + window.scrollY, w: r.width, h: r.height});
                });
                return JSON.stringify(rects);
            })()
            """
            webView.evaluateJavaScript(js) { [weak self] result, _ in
                guard let jsonStr = result as? String,
                      let jsonData = jsonStr.data(using: .utf8),
                      let rects = try? JSONSerialization.jsonObject(with: jsonData) as? [[String: Double]] else {
                    completion(nil)
                    return
                }

                let pageRects = rects.compactMap { dict -> CGRect? in
                    guard let x = dict["x"], let y = dict["y"],
                          let w = dict["w"], let h = dict["h"] else { return nil }
                    return CGRect(x: x, y: y, width: w, height: h)
                }

                guard !pageRects.isEmpty else {
                    completion(nil)
                    return
                }

                self?.capturePages(webView: webView, rects: pageRects, index: 0, document: PDFDocument()) { mergedDoc in
                    // Restore visual gaps
                    let restore = """
                    (function(){
                        var c = document.querySelector('.pagedjs_pages');
                        if (c) c.style.padding = '';
                        document.querySelectorAll('.pagedjs_page').forEach(function(p){
                            p.style.marginBottom = '';
                            p.style.boxShadow = '';
                        });
                    })()
                    """
                    webView.evaluateJavaScript(restore, completionHandler: nil)
                    completion(mergedDoc.dataRepresentation())
                }
            }
        }

        private func capturePages(webView: WKWebView, rects: [CGRect], index: Int, document: PDFDocument, completion: @escaping (PDFDocument) -> Void) {
            guard index < rects.count else {
                completion(document)
                return
            }
            let config = WKPDFConfiguration()
            config.rect = rects[index]
            webView.createPDF(configuration: config) { [weak self] result in
                if case .success(let data) = result,
                   let pagePDF = PDFDocument(data: data),
                   let page = pagePDF.page(at: 0) {
                    document.insert(page, at: document.pageCount)
                }
                self?.capturePages(webView: webView, rects: rects, index: index + 1, document: document, completion: completion)
            }
        }

        func render(_ content: String) {
            guard content != lastRenderedContent else { return }
            lastRenderedContent = content
            if isLoaded {
                evaluateRender(content)
            } else {
                pendingContent = content
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            isLoaded = true
            if let url = pendingBaseURL {
                pendingBaseURL = nil
                evaluateBaseURL(url)
            }
            if let (mode, config) = pendingViewMode {
                pendingViewMode = nil
                evaluateViewMode(mode, configJSON: config)
            }
            if let theme = pendingTheme {
                pendingTheme = nil
                evaluateTheme(theme)
            }
            if let content = pendingContent {
                pendingContent = nil
                evaluateRender(content)
            }
        }

        private func evaluateRender(_ content: String) {
            guard let webView else { return }
            guard let jsonData = try? JSONEncoder().encode(content),
                  let jsonString = String(data: jsonData, encoding: .utf8) else { return }
            let js = "renderMarkdown(\(jsonString))"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
