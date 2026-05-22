import Foundation

/// Pure decision logic for reconciling editor writes with the file watcher.
/// Kept free of UI/`@MainActor` so it can be unit-tested directly.
enum EditorSync {
    /// True when an on-disk change is merely the echo of what the editor last
    /// wrote itself, so the watcher should ignore it — no reload, no conflict,
    /// no cursor jump. Any genuinely different content (or never having saved)
    /// is a real external change.
    static func shouldIgnoreReload(disk: String, lastSaved: String?) -> Bool {
        guard let lastSaved else { return false }
        return disk == lastSaved
    }
}
