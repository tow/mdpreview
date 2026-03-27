import Foundation

@MainActor
final class FileNode: Identifiable, ObservableObject {
    let url: URL
    var name: String { url.lastPathComponent }
    let isDirectory: Bool

    @Published var children: [FileNode]?
    @Published var isExpanded: Bool = false

    nonisolated var id: URL { url }

    init(url: URL, isDirectory: Bool) {
        self.url = url
        self.isDirectory = isDirectory
    }

    func loadChildrenIfNeeded() {
        guard isDirectory, children == nil else { return }
        children = Self.loadChildren(of: url)
    }

    static func loadChildren(of url: URL) -> [FileNode] {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey, .isHiddenKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }

        var nodes: [FileNode] = []
        for entry in entries {
            let isDir = (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            if isDir {
                // Only include directories that contain at least one .md file (recursively)
                if containsMarkdown(url: entry) {
                    nodes.append(FileNode(url: entry, isDirectory: true))
                }
            } else if entry.pathExtension.lowercased() == "md" {
                nodes.append(FileNode(url: entry, isDirectory: false))
            }
        }

        return nodes.sorted { a, b in
            if a.isDirectory != b.isDirectory { return a.isDirectory }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    private static func containsMarkdown(url: URL) -> Bool {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(
            at: url,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return false }
        for case let fileURL as URL in enumerator {
            if fileURL.pathExtension.lowercased() == "md" { return true }
        }
        return false
    }
}
