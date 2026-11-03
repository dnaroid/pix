import AppKit
import ApplicationServices
import Foundation

// Modeless tool windows need not be AXFocusedWindow. Resolve an explicit title
// within this app, without guessing or changing global focus.
func selectedWindow(_ app: NSRunningApplication, arguments: Arguments) throws -> AXUIElement {
    guard let title = arguments.value("window-title") else { return try frontWindow(app) }
    guard !title.isEmpty, title.utf8.count <= 1024, !title.contains("\u{0}") else {
        throw Failure("invalid --window-title")
    }
    let application = axApplication(app)
    AXUIElementSetMessagingTimeout(application, 1)
    let windows = copyAttribute(application, kAXWindowsAttribute) as? [AXUIElement] ?? []
    var matches: [AXUIElement] = []
    var available: [String] = []
    for window in windows.prefix(100) {
        AXUIElementSetMessagingTimeout(window, 0.1)
        if let name = stringAttribute(window, kAXTitleAttribute) {
            available.append(name)
            if name == title { matches.append(window) }
        }
    }
    guard matches.count == 1 else {
        throw Failure("window title \(quoted(title)) matches=\(matches.count); available=\(available)")
    }
    AXUIElementSetMessagingTimeout(matches[0], 1)
    return matches[0]
}
