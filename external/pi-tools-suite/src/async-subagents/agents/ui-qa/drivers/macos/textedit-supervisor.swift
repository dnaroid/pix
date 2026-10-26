import AppKit
import ApplicationServices
import Security

// Input reader may revoke access even while the main thread is in an AX call.
// Only the main thread mutates the lease and retained application handle.
final class TextEditCancellation {
    private let lock = NSLock()
    private var reason: String?
    var firstReason: String? { lock.lock(); defer { lock.unlock() }; return reason }
    func cancel(_ reason: String) { lock.lock(); defer { lock.unlock() }; if self.reason == nil { self.reason = reason } }
    func check() throws { lock.lock(); defer { lock.unlock() }; if let reason { throw Failure(reason) } }
}

final class TextEditSupervisor {
    private var lease = TextEditLease()
    private var app: NSRunningApplication?
    private var field: AXUIElement?
    private var observer: AXObserver?
    private var subscriptions: [(AXUIElement, CFString)] = []
    private let cancellation = TextEditCancellation()
    private var signals: [DispatchSourceSignal] = []
    private var workspaceObservers: [NSObjectProtocol] = []
    private var pending: Int?
    private var cleanupID: Int?
    private var executing = false
    private var deferredCommands: [Data] = []
    private var releaseRequested = false
    private var lastID = 0
    private var done = false
    private var releasing = false
    private var releaseAt: Date?
    private var commandDeadline = Date.distantFuture
    private var expected = ""
    private var inFlight = ""
    private var prepared = false
    private var releaseReason = "manual cleanup"
    private var fixtureIntegrity = "notPrepared"
    private let sessionDeadline = Date().addingTimeInterval(90)

    func run() throws {
        guard AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.5) == .success else {
            throw Failure("cannot bound fixture AX messaging")
        }
        signal(SIGPIPE, SIG_IGN)
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global(qos: .userInitiated))
            source.setEventHandler { [weak self] in
                guard let self else { return }
                self.cancellation.cancel("supervisor signal")
                DispatchQueue.main.async { self.cancel("supervisor signal") }
            }
            source.resume()
            signals.append(source)
        }
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            var buffer = Data()
            while true {
                let data = FileHandle.standardInput.availableData
                if data.isEmpty {
                    cancellation.cancel("supervisor EOF")
                    DispatchQueue.main.async { self.cancel("supervisor EOF") }
                    return
                }
                buffer.append(data)
                if buffer.count > 16_384 {
                    cancellation.cancel("oversized supervisor command")
                    DispatchQueue.main.async { self.cancel("oversized supervisor command") }
                    return
                }
                while let end = buffer.firstIndex(of: 10) {
                    let line = Data(buffer[..<end])
                    buffer.removeSubrange(...end)
                    // Revoke immediately rather than queue behind a running smoke.
                    if let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                       message["command"] as? String == "cleanup" { cancellation.cancel("cleanup requested") }
                    DispatchQueue.main.async { self.receive(line) }
                }
            }
        }
        while !done {
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
            if Date() >= sessionDeadline { cancel("supervisor hard deadline") }
            if let releaseAt, Date() >= releaseAt { finishRelease() }
        }
        removeObserver()
        signals.forEach { $0.cancel() }
    }

    private func send(_ id: Int?, ok: Bool, result: [String: Any]) {
        var message: [String: Any] = ["ok": ok, "phase": lease.phase.rawValue, "result": result]
        if let id { message["id"] = id }
        guard let data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]) else { return }
        try? FileHandle.standardOutput.write(contentsOf: data + Data([10]))
    }

    private func receive(_ data: Data) {
        guard !done else { return }
        if executing {
            guard deferredCommands.count < 16 else { cancel("too many queued commands"); return }
            deferredCommands.append(data)
            return
        }
        executing = true
        defer {
            executing = false
            if releaseRequested { beginRelease() }
            let queued = deferredCommands
            deferredCommands.removeAll()
            for command in queued { receive(command) }
        }
        var id: Int?
        do {
            guard let message = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let number = message["id"] as? Int, number > lastID,
                  let command = message["command"] as? String,
                  Set(message.keys).isSubset(of: ["id", "command"]) else {
                throw Failure("invalid supervisor protocol")
            }
            id = number
            lastID = number
            if command == "cleanup" {
                if let active = pending { send(active, ok: false, result: ["error": "cancelled by cleanup"]) }
                pending = nil
                cleanupID = number
                cancel("cleanup requested")
                return
            }
            guard pending == nil, !releasing else { throw Failure("overlapping or released command") }
            try cancellation.check()
            pending = number
            switch command {
            case "launch":
                try launch()
            case "prepare":
                guard lease.phase == .owned else { throw Failure("prepare is single-use") }
                commandDeadline = Date().addingTimeInterval(5)
                let application = try checkedApp()
                field = try TextEditSmoke.prepare(application)
                try check()
                try installObserver(application)
                prepared = true
                try lease.prepare()
                send(number, ok: true, result: ["blankFocusedDocument": true])
            case "smoke":
                commandDeadline = Date().addingTimeInterval(8)
                try lease.smoke()
                let application = try checkedApp()
                let result = try TextEditSmoke.run(application, check: { try self.check() }, expecting: { old, next in
                    self.expected = old; self.inFlight = next
                })
                try check()
                try lease.smoked()
                send(number, ok: true, result: result)
            case "snapshot":
                commandDeadline = Date().addingTimeInterval(3)
                let application = try checkedApp()
                guard prepared else { throw Failure("snapshot requires prepared fixture") }
                let lines = try snapshot(try frontWindow(application))
                try check()
                send(number, ok: true, result: ["snapshot": lines.joined(separator: "\n")])
            default: throw Failure("unsupported supervisor command")
            }
            if command != "launch", pending == number { pending = nil }
        } catch {
            if pending == nil || pending == id || id == nil { send(id, ok: false, result: ["error": String(describing: error)]) }
            if pending == id { pending = nil }
            cancel("command failed")
        }
    }

    private func snapshot(_ root: AXUIElement) throws -> [String] {
        var lines: [String] = []
        func visit(_ element: AXUIElement, path: String, depth: Int) throws {
            guard lines.count < 100, depth <= 10 else { return }
            try check()
            lines.append(summary(element, path: path))
            try check()
            for (index, child) in children(element).enumerated() {
                guard lines.count < 100 else { break }
                try visit(child, path: "\(path).\(index)", depth: depth + 1)
            }
        }
        try visit(root, path: "0", depth: 0)
        return lines
    }

    private func launch() throws {
        try TextEditSmoke.preflight()
        let url = URL(fileURLWithPath: "/System/Applications/TextEdit.app")
        let executable = url.appendingPathComponent("Contents/MacOS/TextEdit")
        for target in [url, executable] {
            guard target.resolvingSymlinksInPath().path == target.path else { throw Failure("TextEdit path contains symlinks") }
        }
        guard let bundle = Bundle(url: url), bundle.bundleIdentifier == TextEditSmoke.bundleID,
              bundle.executableURL == executable,
              FileManager.default.isExecutableFile(atPath: executable.path) else { throw Failure("unexpected TextEdit bundle metadata") }
        // Launch arguments are ignored for sandboxed callers. Fail closed, including
        // when the helper's signature/entitlements cannot be inspected.
        var code: SecCode?
        var staticCode: SecStaticCode?
        var information: CFDictionary?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
              SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
              SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let info = information as? [String: Any] else { throw Failure("cannot inspect helper entitlements") }
        let entitlements = info[kSecCodeInfoEntitlementsDict as String] as? [String: Any] ?? [:]
        guard (entitlements["com.apple.security.app-sandbox"] as? Bool) != true else { throw Failure("sandboxed supervisor is unsupported") }
        try lease.launch()
        commandDeadline = Date().addingTimeInterval(15)
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        configuration.allowsRunningApplicationSubstitution = false
        configuration.activates = false
        configuration.addsToRecentItems = false
        configuration.promptsUserIfNeeded = false
        configuration.arguments = ["-ApplePersistenceIgnoreState", "YES", "-NSQuitAlwaysKeepsWindows", "NO", "-NSShowAppCentricOpenPanelInsteadOfUntitledFile", "NO"]
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { application, error in
            DispatchQueue.main.async { self.completed(application, error: error) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            guard let self, !self.lease.completionSeen, !self.releasing else { return }
            if let pending = self.pending { self.send(pending, ok: false, result: ["error": "LaunchServices completion timeout"]) }
            self.pending = nil
            self.cancel("launch timeout")
        }
    }

    private func completed(_ application: NSRunningApplication?, error: Error?) {
        guard !lease.completionSeen, !done else { return }
        var failure = error.map { String(describing: $0) }
        do {
            try cancellation.check()
            guard Date() < commandDeadline, let application else { throw Failure("missing or late launch handle") }
            try TextEditSmoke.validateInstance(application)
        } catch { failure = String(describing: error) }
        guard lease.complete(hasHandle: application != nil, admitted: failure == nil) else { return }
        app = application // Even rejected/late handles only authorize diagnostics.
        if releasing { finishRelease(); return }
        send(pending, ok: failure == nil, result: failure.map { ["error": $0] } ?? ["launchServices": true, "pidDiagnosticOnly": application!.processIdentifier])
        pending = nil
        if failure != nil { cancel("launch admission failed") }
    }

    private func checkedApp() throws -> NSRunningApplication {
        try cancellation.check()
        try lease.requireLive()
        guard Date() < commandDeadline, let app else { throw Failure("missing or expired lease") }
        try TextEditSmoke.validateInstance(app)
        return app
    }

    private func check() throws {
        let application = try checkedApp()
        if prepared, let field {
            _ = try TextEditSmoke.field(application, sameAs: field)
            let value = stringAttribute(field, kAXValueAttribute)
            guard TextEditAdmission.value(value, confirmed: expected, inFlight: inFlight) else { throw Failure("fixture content changed or unreadable") }
        }
        try cancellation.check()
        try TextEditSmoke.validateInstance(application)
        try cancellation.check()
    }

    private func installObserver(_ application: NSRunningApplication) throws {
        var created: AXObserver?
        let callback: AXObserverCallback = { _, _, _, context in
            guard let context else { return }
            let owner = Unmanaged<TextEditSupervisor>.fromOpaque(context).takeUnretainedValue()
            do { try owner.check() } catch {
                owner.cancellation.cancel("AX observer guard failed")
                // Never tear down the observer from inside its own callback.
                DispatchQueue.main.async { owner.cancel("AX observer guard failed") }
            }
        }
        guard AXObserverCreate(application.processIdentifier, callback, &created) == .success, let created, let field else {
            throw Failure("cannot observe TextEdit fixture")
        }
        observer = created
        let root = axApplication(application)
        for (element, name) in [(root, kAXWindowCreatedNotification), (root, kAXFocusedWindowChangedNotification), (root, kAXFocusedUIElementChangedNotification), (field, kAXValueChangedNotification), (field, kAXUIElementDestroyedNotification)] {
            let notification = name as CFString
            guard AXObserverAddNotification(created, element, notification, Unmanaged.passUnretained(self).toOpaque()) == .success else {
                throw Failure("required TextEdit AX notification unavailable: \(name)")
            }
            subscriptions.append((element, notification))
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .defaultMode)
        let center = NSWorkspace.shared.notificationCenter
        for notification in [NSWorkspace.didDeactivateApplicationNotification, NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
            workspaceObservers.append(center.addObserver(forName: notification, object: nil, queue: .main) { [weak self] event in
                guard let self, let changed = event.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
                if changed.isEqual(self.app) || changed.bundleIdentifier == TextEditSmoke.bundleID {
                    self.cancel("workspace identity/focus event")
                }
            })
        }
    }

    private func removeObserver() {
        workspaceObservers.forEach { NSWorkspace.shared.notificationCenter.removeObserver($0) }
        workspaceObservers.removeAll()
        guard let observer else { return }
        for (element, name) in subscriptions { AXObserverRemoveNotification(observer, element, name) }
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
        subscriptions.removeAll()
        self.observer = nil
    }

    private func cancel(_ reason: String) {
        cancellation.cancel(reason)
        if !releaseRequested { releaseReason = cancellation.firstReason ?? reason }
        beginRelease()
    }

    private func beginRelease() {
        releaseRequested = true
        guard !executing else { return }
        guard !releasing else { return }
        releasing = true
        lease.abandon()
        removeObserver()
        if prepared, let app, let field {
            // Diagnostic only. Unknown/changed content never authorizes closing.
            do {
                _ = try TextEditSmoke.field(app, sameAs: field)
                let value = stringAttribute(field, kAXValueAttribute)
                try TextEditSmoke.validateInstance(app)
                fixtureIntegrity = inFlight == expected && value == expected ? "lastConfirmedPrefix" : "changedOrUnknown"
            } catch { fixtureIntegrity = "changedOrUnknown" }
        }
        // 3s late drain + <=2s parent-owned helper release fits runner's 10s grace.
        releaseAt = Date().addingTimeInterval(lease.requested && !lease.completionSeen ? 3 : 0)
    }

    private func finishRelease() {
        guard !done else { return }
        let exited = app.map { retained in
            retained.isTerminated && !NSWorkspace.shared.runningApplications.contains { $0.isEqual(retained) }
        } ?? false
        let cleanup = lease.release(observedExit: exited)
        if let pending { send(pending, ok: false, result: ["error": "cancelled before completion"]) }
        send(cleanupID, ok: true, result: ["cleanup": cleanup, "manualCloseRequired": !exited && lease.requested,
                                       "fixtureIntegrity": fixtureIntegrity, "releaseReason": releaseReason])
        pending = nil
        done = true
    }
}
