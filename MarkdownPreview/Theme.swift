import Foundation

struct Theme: Identifiable, Hashable {
    let id: String
    let name: String
    let cssFile: String
    let codeThemeFile: String

    static let all: [Theme] = [
        Theme(id: "github",   name: "GitHub",   cssFile: "github-markdown.min.css", codeThemeFile: "highlight-github.min.css"),
        Theme(id: "water",    name: "Water",    cssFile: "theme-water.css",          codeThemeFile: "highlight-dark.min.css"),
        Theme(id: "sakura",   name: "Sakura",   cssFile: "theme-sakura.css",         codeThemeFile: "highlight-github.min.css"),
        Theme(id: "simple",   name: "Simple",   cssFile: "theme-simple.css",         codeThemeFile: "highlight-github.min.css"),
        Theme(id: "splendor", name: "Splendor", cssFile: "theme-splendor.css",       codeThemeFile: "highlight-github.min.css"),
        Theme(id: "air",      name: "Air",      cssFile: "theme-air.css",            codeThemeFile: "highlight-github.min.css"),
    ]
}
