import AppKit

final class FixtureDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var countLabel: NSTextField!
    private var count = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 220),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "UI QA Accessibility Fixture"
        window.center()

        countLabel = NSTextField(labelWithString: "Count: 0")
        countLabel.identifier = NSUserInterfaceItemIdentifier("count-label")
        countLabel.frame = NSRect(x: 40, y: 125, width: 300, height: 30)

        let button = NSButton(title: "Increment", target: self, action: #selector(increment))
        button.identifier = NSUserInterfaceItemIdentifier("increment-button")
        button.frame = NSRect(x: 40, y: 65, width: 130, height: 36)

        window.contentView?.addSubview(countLabel)
        window.contentView?.addSubview(button)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func increment() {
        count += 1
        countLabel.stringValue = "Count: \(count)"
    }
}

let application = NSApplication.shared
let delegate = FixtureDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
