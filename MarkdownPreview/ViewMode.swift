import Foundation

enum ViewMode: String, CaseIterable, Identifiable, Equatable {
    case reading
    case document

    var id: String { rawValue }

    var label: String {
        switch self {
        case .reading: return "Reading"
        case .document: return "Document"
        }
    }

    var icon: String {
        switch self {
        case .reading: return "scroll"
        case .document: return "doc.richtext"
        }
    }
}
