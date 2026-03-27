import SwiftUI

struct FileTreeView: View {
    let nodes: [FileNode]
    @Binding var selectedFile: URL?
    var directoryName: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !directoryName.isEmpty {
                HStack(spacing: 4) {
                    Image(systemName: "folder.fill")
                        .foregroundStyle(.secondary)
                        .font(.caption)
                    Text(directoryName)
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
            }
            List(nodes, children: \.directoryChildren, selection: $selectedFile) { node in
                Label {
                    Text(node.name)
                        .lineLimit(1)
                } icon: {
                    Image(systemName: node.isDirectory ? "folder.fill" : "doc.text")
                        .foregroundStyle(node.isDirectory ? .yellow : .secondary)
                }
                .tag(node.isDirectory ? nil : node.url as URL?)
            }
        }
    }
}

extension FileNode {
    /// Returns children for directory nodes (loading lazily), nil for files.
    var directoryChildren: [FileNode]? {
        guard isDirectory else { return nil }
        if children == nil {
            loadChildrenIfNeeded()
        }
        return children?.isEmpty == false ? children : nil
    }
}
