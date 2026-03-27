import SwiftUI
import WebKit
import UniformTypeIdentifiers

struct MarkdownWebView: NSViewRepresentable {
    let markdownContent: String
    let exportTrigger: Int
    let viewPDFTrigger: Int
    var exportFilename: String = "document"
    var theme: Theme = Theme.all[0]

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView

        if let resourcesURL = Bundle.main.resourceURL {
            let templateURL = resourcesURL.appendingPathComponent("template.html")
            webView.loadFileURL(templateURL, allowingReadAccessTo: resourcesURL)
        }

        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.render(markdownContent)
        if theme.id != context.coordinator.lastThemeID {
            context.coordinator.lastThemeID = theme.id
            context.coordinator.applyTheme(theme)
        }
        if exportTrigger != context.coordinator.lastExportTrigger {
            context.coordinator.lastExportTrigger = exportTrigger
            context.coordinator.exportPDF(filename: exportFilename)
        }
        if viewPDFTrigger != context.coordinator.lastViewPDFTrigger {
            context.coordinator.lastViewPDFTrigger = viewPDFTrigger
            context.coordinator.viewPDF(filename: exportFilename)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        weak var webView: WKWebView?
        private var isLoaded = false
        private var pendingContent: String?
        private var pendingTheme: Theme?
        var lastExportTrigger: Int = 0
        var lastViewPDFTrigger: Int = 0
        var lastThemeID: String = ""

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

        func exportPDF(filename: String) {
            guard let webView else { return }
            webView.createPDF(configuration: WKPDFConfiguration()) { result in
                guard case .success(let data) = result else { return }
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
            webView.createPDF(configuration: WKPDFConfiguration()) { result in
                guard case .success(let data) = result else { return }
                let url = FileManager.default.temporaryDirectory
                    .appendingPathComponent(filename + ".pdf")
                try? data.write(to: url)
                NSWorkspace.shared.open(url)
            }
        }

        func render(_ content: String) {
            if isLoaded {
                evaluateRender(content)
            } else {
                pendingContent = content
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            isLoaded = true
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
            // JSON-encode the string so backslashes, quotes, newlines are safely escaped
            guard let jsonData = try? JSONEncoder().encode(content),
                  let jsonString = String(data: jsonData, encoding: .utf8) else { return }
            let js = "renderMarkdown(\(jsonString))"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
