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
    func budget(_ element: AXUIElement, stage: String) throws {
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0 else { throw Failure("menu activation timed out at \(stage)") }
        AXUIElementSetMessagingTimeout(element, Float(min(1, remaining)))
    }
    func trace(_ stage: String) {
        FileHandle.standardError.write(Data("menu-stage: \(stage)\n".utf8))
    }
    trace("activate")
    try activate(app, messagingTimeout: Float(min(1, timeout)))
    let application = axApplication(app)
    trace("menu-bar")
    try budget(application, stage: "menu-bar")
    guard let raw = copyAttribute(application, kAXMenuBarAttribute),
          CFGetTypeID(raw) == AXUIElementGetTypeID()
    else { throw Failure("selected app has no accessible menu bar") }
    var container = unsafeBitCast(raw, to: AXUIElement.self)
    for (index, title) in titles.enumerated() {
        let stage = "item[\(index)] \(quoted(title))"
        trace("resolve " + stage)
        let expectedRole = index == 0 ? kAXMenuBarItemRole : kAXMenuItemRole
        var candidates: [AXUIElement] = []
        var available: [String] = []
        repeat {
            try budget(container, stage: stage)
            candidates = []
            available = []
            for child in children(container) {
                try budget(child, stage: stage)
                let itemTitle = stringAttribute(child, kAXTitleAttribute)
                if let itemTitle { available.append(itemTitle) }
                try budget(child, stage: stage)
                if role(child) == expectedRole && itemTitle == title {
                    candidates.append(child)
                }
            }
            if !candidates.isEmpty { break }
            RunLoop.current.run(until: min(Date().addingTimeInterval(0.05), deadline))
        } while Date() < deadline
        guard candidates.count == 1, let item = candidates.first else {
            throw Failure("menu title \(quoted(title)) matches=\(candidates.count); available=\(available)")
        }
        try budget(item, stage: stage)
        guard scalarAttribute(item, kAXEnabledAttribute) != "false" else {
            throw Failure("menu item is disabled: \(quoted(title))")
        }
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0 else { throw Failure("menu activation timed out") }
        trace("press " + stage)
        AXUIElementSetMessagingTimeout(item, Float(min(1, remaining)))
        let result = AXUIElementPerformAction(item, kAXPressAction as CFString)
        guard result == .success else {
            throw Failure("AXPress failed for menu \(quoted(title)): \(result.rawValue)")
        }
        if index < titles.count - 1 {
            trace("submenu " + stage)
            var submenu: AXUIElement?
            repeat {
                try budget(item, stage: stage)
                submenu = nil
                for child in children(item) {
                    try budget(child, stage: stage)
                    if role(child) == kAXMenuRole { submenu = child; break }
                }
                if submenu != nil { break }
                RunLoop.current.run(until: min(Date().addingTimeInterval(0.05), deadline))
            } while Date() < deadline
            guard let submenu else { throw Failure("submenu did not appear for \(quoted(title))") }
            container = submenu
        }
    }
    print("menu-activated path=\(encoded) pid=\(app.processIdentifier)")
}
