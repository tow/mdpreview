import Foundation

struct PDFMargins: Codable {
    var top: Double = 25
    var right: Double = 20
    var bottom: Double = 25
    var left: Double = 20
}

struct PDFHeaderFooter: Codable {
    var left: String = ""
    var center: String = ""
    var right: String = ""
}

struct PDFConfig: Codable {
    var pageSize: String = "A4"
    var margins: PDFMargins = PDFMargins()
    var header: PDFHeaderFooter = PDFHeaderFooter(left: "{{title}}", center: "", right: "{{date}}")
    var footer: PDFHeaderFooter = PDFHeaderFooter(left: "", center: "Page {{page}} of {{pages}}", right: "")
    var logoPath: String = ""
    var companyLine: String = ""

    // MARK: - File location

    private static var configDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("MarkdownPreview")
    }

    private static var configURL: URL {
        configDirectory.appendingPathComponent("pdf.json")
    }

    // MARK: - Load / create default

    static func load() -> PDFConfig {
        let url = configURL
        guard FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url),
              let config = try? JSONDecoder().decode(PDFConfig.self, from: data) else {
            let defaultConfig = PDFConfig()
            defaultConfig.save()
            return defaultConfig
        }
        return config
    }

    func save() {
        let dir = PDFConfig.configDirectory
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(self) {
            try? data.write(to: PDFConfig.configURL)
        }
    }

    // MARK: - Resolve template variables and produce JSON for JavaScript

    func resolvedJSON(title: String, date: String) -> String {
        var dict: [String: Any] = [
            "pageSize": pageSize,
            "margins": [
                "top": margins.top,
                "right": margins.right,
                "bottom": margins.bottom,
                "left": margins.left
            ],
            "header": [
                "left": resolve(header.left, title: title, date: date),
                "center": resolve(header.center, title: title, date: date),
                "right": resolve(header.right, title: title, date: date)
            ],
            "footer": [
                "left": resolve(footer.left, title: title, date: date),
                "center": resolve(footer.center, title: title, date: date),
                "right": resolve(footer.right, title: title, date: date)
            ]
        ]

        if let base64 = logoBase64() {
            dict["logoBase64"] = base64
        }

        if !companyLine.isEmpty {
            dict["companyLine"] = resolve(companyLine, title: title, date: date)
        }

        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let json = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return json
    }

    // MARK: - Logo

    func logoBase64() -> String? {
        guard !logoPath.isEmpty else { return nil }
        let expanded = NSString(string: logoPath).expandingTildeInPath
        let url = URL(fileURLWithPath: expanded)
        guard let data = try? Data(contentsOf: url) else { return nil }

        let ext = url.pathExtension.lowercased()
        let mime: String
        switch ext {
        case "png": mime = "image/png"
        case "jpg", "jpeg": mime = "image/jpeg"
        case "svg": mime = "image/svg+xml"
        default: mime = "image/png"
        }
        return "data:\(mime);base64,\(data.base64EncodedString())"
    }

    // MARK: - Private

    /// Replace {{title}} and {{date}} — leave {{page}}/{{pages}} for CSS counter resolution in JS
    private func resolve(_ str: String, title: String, date: String) -> String {
        str.replacingOccurrences(of: "{{title}}", with: title)
           .replacingOccurrences(of: "{{date}}", with: date)
    }
}
