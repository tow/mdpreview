import XCTest
@testable import MarkdownPreview

final class EditorSyncTests: XCTestCase {
    func testIgnoresOwnEcho() {
        // The watcher fires on our own atomic write; that must be ignored.
        XCTAssertTrue(EditorSync.shouldIgnoreReload(disk: "hello world", lastSaved: "hello world"))
    }

    func testAcceptsGenuineExternalChange() {
        XCTAssertFalse(EditorSync.shouldIgnoreReload(disk: "changed by Claude", lastSaved: "hello world"))
    }

    func testAcceptsChangeWhenNothingSavedYet() {
        XCTAssertFalse(EditorSync.shouldIgnoreReload(disk: "hello world", lastSaved: nil))
    }
}
