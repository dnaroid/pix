import AppKit
import ApplicationServices
import Foundation

// Resolve only the selected application's menu bar, never the system-wide tree.
// The complete path is handled in one invocation so open submenus stay alive.
func activateMenu(_ app: NSRunningApplication, arguments: Arguments) throws {
    let encoded = try arguments.required("menu-path")
    guard let data = encoded.data(using: .utf8),
          let titles = try JSONSerialization.jsonObject(with: data) as? [String],
          (1...8).contains(titles.count),
          titles.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 1024 && !$0.contains("\u{0}") })
    else { throw Failure("--menu-path must be a JSON array of 1..8 nonempty menu titles") }
    let timeout = try arguments.double("timeout", default: 10)
    guard timeout.isFinite, timeout > 0, timeout <= 30 else { throw Failure("invalid menu timeout") }
    let deadline = Date().addingTimeInterval(timeout)
    let application = axApplication(app)
    guard let raw = copyAttribute(application, kAXMenuBarAttribute),
          CFGetTypeID(raw) == AXUIElementGetTypeID()
    else { throw Failure("selected app has no accessible menu bar") }
    var container = unsafeBitCast(raw, to: AXUIElement.self)
    for (index, title) in titles.enumerated() {
        let expectedRole = index == 0 ? kAXMenuBarItemRole : kAXMenuItemRole
        var candidates: [AXUIElement] = []
        repeat {
            candidates = children(container).filter {
                role($0) == expectedRole && stringAttribute($0, kAXTitleAttribute) == title
            }
            if !candidates.isEmpty { break }
            RunLoop.current.run(until: min(Date().addingTimeInterval(0.05), deadline))
        } while Date() < deadline
        guard candidates.count == 1, let item = candidates.first else {
            let available = children(container).compactMap { stringAttribute($0, kAXTitleAttribute) }
            throw Failure("menu title \(quoted(title)) matches=\(candidates.count); available=\(available)")
        }
        guard scalarAttribute(item, kAXEnabledAttribute) != "false" else {
            throw Failure("menu item is disabled: \(quoted(title))")
        }
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0 else { throw Failure("menu activation timed out") }
        AXUIElementSetMessagingTimeout(item, Float(remaining))
        let result = AXUIElementPerformAction(item, kAXPressAction as CFString)
        guard result == .success else {
            throw Failure("AXPress failed for menu \(quoted(title)): \(result.rawValue)")
        }
        if index < titles.count - 1 {
            var submenu: AXUIElement?
            repeat {
                submenu = children(item).first { role($0) == kAXMenuRole }
                if submenu != nil { break }
                RunLoop.current.run(until: min(Date().addingTimeInterval(0.05), deadline))
            } while Date() < deadline
            guard let submenu else { throw Failure("submenu did not appear for \(quoted(title))") }
            container = submenu
        }
    }
    print("menu-activated path=\(encoded) pid=\(app.processIdentifier)")
}
