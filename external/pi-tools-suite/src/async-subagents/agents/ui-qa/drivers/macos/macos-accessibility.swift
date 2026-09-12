import AppKit
import ApplicationServices
import AVFoundation
import CoreMedia
import Darwin
import Foundation
import ScreenCaptureKit

struct Failure: Error, CustomStringConvertible {
    let description: String

    init(_ description: String) {
        self.description = description
    }
}

struct Arguments {
    let command: String
    private let options: [String: String]
    private let flags: Set<String>

    init(_ values: [String]) throws {
        guard let command = values.first else {
            throw Failure(Self.usage)
        }
        self.command = command

        let valueOptions: Set<String> = [
            "--app", "--bundle-id", "--pid", "--pgid", "--depth", "--limit", "--match",
            "--role", "--occurrence", "--path", "--value", "--text",
            "--key", "--modifiers", "--x", "--y", "--out", "--timeout", "--duration",
        ]
        var parsedOptions: [String: String] = [:]
        var parsedFlags = Set<String>()
        var index = 1
        while index < values.count {
            let argument = values[index]
            guard argument.hasPrefix("--") else {
                throw Failure("unexpected argument: \(argument)")
            }
            if valueOptions.contains(argument) {
                guard index + 1 < values.count else {
                    throw Failure("missing value for \(argument)")
                }
                parsedOptions[argument] = values[index + 1]
                index += 2
            } else {
                parsedFlags.insert(argument)
                index += 1
            }
        }
        options = parsedOptions
        flags = parsedFlags
    }

    func value(_ name: String) -> String? {
        options["--\(name)"]
    }

    func required(_ name: String) throws -> String {
        guard let value = value(name), !value.isEmpty else {
            throw Failure("missing --\(name)")
        }
        return value
    }

    func integer(_ name: String, default fallback: Int) throws -> Int {
        guard let raw = value(name) else { return fallback }
        guard let parsed = Int(raw) else {
            throw Failure("invalid integer for --\(name): \(raw)")
        }
        return parsed
    }

    func double(_ name: String, default fallback: Double? = nil) throws -> Double {
        if let raw = value(name), let parsed = Double(raw) {
            return parsed
        }
        if let fallback { return fallback }
        throw Failure("missing or invalid --\(name)")
    }

    func has(_ name: String) -> Bool {
        flags.contains("--\(name)")
    }

    static let usage = """
    usage: macos-window.sh COMMAND [options]
      doctor [--prompt]
      list
      App selectors: --pid PID (preferred), --pgid PGID, --app NAME, --bundle-id ID
      wait-window SELECTOR [--timeout 60] [--print-pid]
      focus SELECTOR
      inspect SELECTOR [--depth 10] [--limit 80] [--all]
      describe SELECTOR (--path PATH | --match TEXT [--role ROLE] [--occurrence N])
      screenshot SELECTOR --out FILE
      window-id SELECTOR
      record-window SELECTOR --out FILE [--duration SECONDS]
      click SELECTOR (--path PATH | --match TEXT [--role ROLE] [--occurrence N]) [--frame-fallback]
      set-value SELECTOR (--path PATH | --match TEXT) --value TEXT
      type SELECTOR --text TEXT
      key SELECTOR --key KEY [--modifiers cmd,shift,ctrl,opt]
      click-point SELECTOR --x X --y Y
      quit SELECTOR [--force]
    """
}

func copyAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
        return nil
    }
    return value
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
    copyAttribute(element, name) as? String
}

func scalarAttribute(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = copyAttribute(element, name) else { return nil }
    if let string = value as? String { return string }
    if CFGetTypeID(value) == CFBooleanGetTypeID(), let boolean = value as? NSNumber {
        return boolean.boolValue ? "true" : "false"
    }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    copyAttribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
}

func pointAttribute(_ element: AXUIElement, _ name: String) -> CGPoint? {
    guard let raw = copyAttribute(element, name), CFGetTypeID(raw) == AXValueGetTypeID() else {
        return nil
    }
    var point = CGPoint.zero
    guard AXValueGetValue(raw as! AXValue, .cgPoint, &point) else { return nil }
    return point
}

func sizeAttribute(_ element: AXUIElement, _ name: String) -> CGSize? {
    guard let raw = copyAttribute(element, name), CFGetTypeID(raw) == AXValueGetTypeID() else {
        return nil
    }
    var size = CGSize.zero
    guard AXValueGetValue(raw as! AXValue, .cgSize, &size) else { return nil }
    return size
}

func frame(_ element: AXUIElement) -> CGRect? {
    guard let position = pointAttribute(element, kAXPositionAttribute),
          let size = sizeAttribute(element, kAXSizeAttribute)
    else { return nil }
    return CGRect(origin: position, size: size)
}

func compact(_ value: String?, limit: Int = 72) -> String? {
    guard let value else { return nil }
    let singleLine = value
        .replacingOccurrences(of: "\n", with: " ")
        .replacingOccurrences(of: "\r", with: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !singleLine.isEmpty else { return nil }
    if singleLine.count <= limit { return singleLine }
    return String(singleLine.prefix(limit - 1)) + "…"
}

func role(_ element: AXUIElement) -> String {
    stringAttribute(element, kAXRoleAttribute) ?? "AXUnknown"
}

func fields(_ element: AXUIElement) -> [(String, String)] {
    let elementRole = role(element)
    var result: [(String, String)] = []
    let pairs = [
        ("title", kAXTitleAttribute),
        ("description", kAXDescriptionAttribute),
        ("identifier", kAXIdentifierAttribute),
        ("help", kAXHelpAttribute),
    ]
    for (label, attribute) in pairs {
        if let value = compact(stringAttribute(element, attribute)) {
            result.append((label, value))
        }
    }
    if elementRole == "AXSecureTextField" {
        result.append(("value", "<redacted>"))
    } else if let value = compact(scalarAttribute(element, kAXValueAttribute)) {
        result.append(("value", value))
    }
    for (label, attribute) in [
        ("enabled", kAXEnabledAttribute),
        ("focused", kAXFocusedAttribute),
        ("selected", kAXSelectedAttribute),
    ] {
        if let value = scalarAttribute(element, attribute) {
            result.append((label, value))
        }
    }
    return result
}

func quoted(_ value: String) -> String {
    "\"" + value.replacingOccurrences(of: "\"", with: "\\\"") + "\""
}

func summary(_ element: AXUIElement, path: String) -> String {
    var parts = [path, role(element)]
    parts.append(contentsOf: fields(element).map { "\($0.0)=\(quoted($0.1))" })
    if let rectangle = frame(element) {
        parts.append(
            "frame=\(Int(rectangle.origin.x)),\(Int(rectangle.origin.y))," +
                "\(Int(rectangle.width))x\(Int(rectangle.height))"
        )
    }
    return parts.joined(separator: " ")
}

func findApplication(_ arguments: Arguments) throws -> NSRunningApplication {
    let requestedName = arguments.value("app")
    let requestedBundle = arguments.value("bundle-id")
    let requestedPID = try arguments.value("pid").map {
        guard let pid = Int32($0), pid > 0 else { throw Failure("invalid --pid: \($0)") }
        return pid
    }
    let requestedPGID = try arguments.value("pgid").map {
        guard let pgid = Int32($0), pgid > 0 else { throw Failure("invalid --pgid: \($0)") }
        return pgid
    }
    guard requestedName != nil || requestedBundle != nil || requestedPID != nil || requestedPGID != nil else {
        throw Failure("missing app selector (--pid, --pgid, --app, or --bundle-id)")
    }

    // `NSWorkspace.runningApplications` can remain stale when this helper starts
    // before a newly spawned GUI process has registered with LaunchServices.
    // Resolve an explicit PID directly so wait-window can observe that process
    // once AppKit finishes launching instead of polling a cached empty snapshot.
    var candidates: [NSRunningApplication]
    if let requestedPID, let application = NSRunningApplication(processIdentifier: requestedPID),
       !application.isTerminated
    {
        candidates = [application]
    } else {
        candidates = NSWorkspace.shared.runningApplications.filter { !$0.isTerminated }
        if requestedPID != nil { candidates = [] }
    }
    if let requestedPGID {
        candidates = candidates.filter { getpgid($0.processIdentifier) == requestedPGID }
    }
    if let requestedBundle {
        candidates = candidates.filter { $0.bundleIdentifier == requestedBundle }
    }
    if let requestedName {
        let exact = candidates.filter {
            $0.localizedName?.caseInsensitiveCompare(requestedName) == .orderedSame
        }
        if !exact.isEmpty {
            candidates = exact
        } else {
            let partial = candidates.filter {
                $0.localizedName?.localizedCaseInsensitiveContains(requestedName) == true
            }
            if !partial.isEmpty {
                candidates = partial
            } else if AXIsProcessTrusted() {
                candidates = candidates.filter { app in
                let application = axApplication(app)
                let windows = copyAttribute(application, kAXWindowsAttribute)
                    as? [AXUIElement] ?? []
                return windows.contains { window in
                    stringAttribute(window, kAXTitleAttribute)?
                        .localizedCaseInsensitiveContains(requestedName) == true
                }
            }
            }
        }
    }
    guard !candidates.isEmpty else {
        throw Failure("no running app matches the supplied selector")
    }
    guard candidates.count == 1 else {
        let preview = candidates.prefix(10).map {
            "\($0.localizedName ?? "?") pid=\($0.processIdentifier)"
        }.joined(separator: ", ")
        throw Failure("ambiguous app selector (\(candidates.count) matches): \(preview); use --pid")
    }
    return candidates[0]
}

func axApplication(_ app: NSRunningApplication) -> AXUIElement {
    AXUIElementCreateApplication(app.processIdentifier)
}

func frontWindow(_ app: NSRunningApplication) throws -> AXUIElement {
    let application = axApplication(app)
    if let focused = copyAttribute(application, kAXFocusedWindowAttribute) {
        return unsafeBitCast(focused, to: AXUIElement.self)
    }
    guard let window = (copyAttribute(application, kAXWindowsAttribute) as? [AXUIElement])?.first else {
        throw Failure("no accessible window for \(app.localizedName ?? "app")")
    }
    return window
}

func focusedElement(_ app: NSRunningApplication) throws -> AXUIElement {
    let application = axApplication(app)
    guard let focused = copyAttribute(application, kAXFocusedUIElementAttribute) else {
        throw Failure("app has no focused accessibility element")
    }
    return unsafeBitCast(focused, to: AXUIElement.self)
}

func requireAccessibility() throws {
    guard AXIsProcessTrusted() else {
        throw Failure("Accessibility permission is disabled; run doctor --prompt")
    }
}

struct LocatedElement {
    let element: AXUIElement
    let path: String
}

func printJSON(_ value: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    guard let encoded = String(data: data, encoding: .utf8) else {
        throw Failure("could not encode accessibility result")
    }
    print(encoded)
}

func record(_ located: LocatedElement) -> [String: Any] {
    var attributes: [String: String] = [:]
    for (name, value) in fields(located.element) { attributes[name] = value }
    var result: [String: Any] = [
        "path": located.path,
        "role": role(located.element),
        "attributes": attributes,
    ]
    if let rectangle = frame(located.element) {
        result["frame"] = [
            "x": rectangle.origin.x,
            "y": rectangle.origin.y,
            "width": rectangle.width,
            "height": rectangle.height,
        ]
    }
    return result
}

func walk(
    _ root: AXUIElement,
    maxDepth: Int,
    maxVisited: Int = 2_000
) -> [LocatedElement] {
    var found: [LocatedElement] = []
    var visited = 0

    func visit(_ element: AXUIElement, path: String, depth: Int) {
        guard visited < maxVisited, depth <= maxDepth else { return }
        visited += 1
        found.append(LocatedElement(element: element, path: path))
        for (index, child) in children(element).enumerated() {
            visit(child, path: "\(path).\(index)", depth: depth + 1)
        }
    }

    visit(root, path: "0", depth: 0)
    return found
}

func resolvePath(_ root: AXUIElement, path: String) throws -> LocatedElement {
    let components = path.split(separator: ".").compactMap { Int($0) }
    guard components.first == 0, components.count == path.split(separator: ".").count else {
        throw Failure("invalid AX path: \(path)")
    }
    var element = root
    var traversed = "0"
    for index in components.dropFirst() {
        let descendants = children(element)
        guard descendants.indices.contains(index) else {
            throw Failure("stale AX path at \(traversed).\(index); inspect again")
        }
        element = descendants[index]
        traversed += ".\(index)"
    }
    return LocatedElement(element: element, path: traversed)
}

func normalizedRole(_ value: String) -> String {
    value.hasPrefix("AX") ? value : "AX" + value.prefix(1).uppercased() + value.dropFirst()
}

func locate(_ root: AXUIElement, arguments: Arguments) throws -> LocatedElement {
    if let path = arguments.value("path") {
        return try resolvePath(root, path: path)
    }
    let query = try arguments.required("match").lowercased()
    let requestedRole = arguments.value("role").map(normalizedRole)
    let candidates = walk(root, maxDepth: 12).filter { candidate in
        if let requestedRole, role(candidate.element) != requestedRole { return false }
        return fields(candidate.element).contains {
            $0.1.lowercased().contains(query)
        }
    }
    guard !candidates.isEmpty else {
        throw Failure("no accessibility element matches \(quoted(query))")
    }
    if let rawOccurrence = arguments.value("occurrence") {
        guard let occurrence = Int(rawOccurrence), occurrence > 0,
              candidates.indices.contains(occurrence - 1)
        else {
            throw Failure("invalid --occurrence \(rawOccurrence); matches=\(candidates.count)")
        }
        return candidates[occurrence - 1]
    }
    guard candidates.count == 1 else {
        let preview = candidates.prefix(10).map {
            "  " + summary($0.element, path: $0.path)
        }.joined(separator: "\n")
        throw Failure("ambiguous match (\(candidates.count)); use --path or --occurrence:\n\(preview)")
    }
    return candidates[0]
}

func activate(_ app: NSRunningApplication) throws {
    let activated = app.activate(options: [.activateAllWindows])
    let application = axApplication(app)
    _ = AXUIElementSetAttributeValue(
        application,
        kAXFrontmostAttribute as CFString,
        kCFBooleanTrue
    )
    if let window = try? frontWindow(app) {
        _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    }
    guard activated || app.isActive else {
        throw Failure("could not activate \(app.localizedName ?? "app")")
    }
    usleep(150_000)
}

func clickGlobal(_ point: CGPoint) throws {
    guard let move = CGEvent(
        mouseEventSource: nil,
        mouseType: .mouseMoved,
        mouseCursorPosition: point,
        mouseButton: .left
    ),
        let down = CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseDown,
            mouseCursorPosition: point,
            mouseButton: .left
        ),
        let up = CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseUp,
            mouseCursorPosition: point,
            mouseButton: .left
        )
    else { throw Failure("could not create mouse event") }
    move.post(tap: .cghidEventTap)
    down.post(tap: .cghidEventTap)
    usleep(40_000)
    up.post(tap: .cghidEventTap)
}

func press(_ located: LocatedElement, allowFrameFallback: Bool) throws -> String {
    let error = AXUIElementPerformAction(located.element, kAXPressAction as CFString)
    if error == .success { return "accessibility" }
    guard allowFrameFallback else {
        throw Failure(
            "AXPress failed (\(error.rawValue)) for path=\(located.path) role=\(role(located.element)); " +
                "inspect again or explicitly pass --frame-fallback"
        )
    }
    guard let rectangle = frame(located.element), !rectangle.isEmpty else {
        throw Failure("AXPress failed (\(error.rawValue)) and element has no frame")
    }
    try clickGlobal(CGPoint(x: rectangle.midX, y: rectangle.midY))
    return "frame-center-fallback"
}

func sendText(_ text: String) throws {
    guard let source = CGEventSource(stateID: .combinedSessionState) else {
        throw Failure("could not create keyboard event source")
    }
    let utf16 = Array(text.utf16)
    for start in stride(from: 0, to: utf16.count, by: 32) {
        let chunk = Array(utf16[start ..< min(start + 32, utf16.count)])
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
        else { throw Failure("could not create keyboard event") }
        chunk.withUnsafeBufferPointer { buffer in
            down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        usleep(10_000)
    }
}

func keyCode(_ name: String) throws -> CGKeyCode {
    let codes: [String: CGKeyCode] = [
        "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51,
        "escape": 53, "esc": 53, "home": 115, "end": 119, "pageup": 116,
        "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126,
        "a": 0, "c": 8, "v": 9, "x": 7, "z": 6,
    ]
    guard let code = codes[name.lowercased()] else {
        throw Failure("unsupported key: \(name)")
    }
    return code
}

func modifierFlags(_ raw: String?) throws -> CGEventFlags {
    var flags: CGEventFlags = []
    for modifier in raw?.split(separator: ",").map(String.init) ?? [] {
        switch modifier.lowercased() {
        case "cmd", "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "ctrl", "control": flags.insert(.maskControl)
        case "opt", "option", "alt": flags.insert(.maskAlternate)
        case "fn": flags.insert(.maskSecondaryFn)
        default: throw Failure("unsupported modifier: \(modifier)")
        }
    }
    return flags
}

func sendKey(name: String, modifiers: String?) throws {
    let code = try keyCode(name)
    let flags = try modifierFlags(modifiers)
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    else { throw Failure("could not create keyboard event") }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

// Correlates the app's focused AX window with the on-screen CGWindow that owns
// it so callers can target exactly that window (never a region or a full
// display) without shell involvement.
func correlatedWindowID(_ app: NSRunningApplication, window: AXUIElement) throws -> CGWindowID {
    let targetFrame = try frame(window).unwrap("focused window has no frame")
    let raw = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] ?? []
    let candidates = raw.compactMap { info -> (CGWindowID, CGRect)? in
        guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == app.processIdentifier,
              (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let number = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let bounds = info[kCGWindowBounds as String] as? NSDictionary,
              let rectangle = CGRect(dictionaryRepresentation: bounds),
              rectangle.width >= 40,
              rectangle.height >= 40
        else { return nil }
        return (number, rectangle)
    }
    guard !candidates.isEmpty else {
        throw Failure("no on-screen window found for screenshot")
    }
    let scored = candidates.map { candidate -> (CGWindowID, CGFloat) in
        let rectangle = candidate.1
        let score = abs(rectangle.minX - targetFrame.minX) + abs(rectangle.minY - targetFrame.minY) +
            abs(rectangle.width - targetFrame.width) + abs(rectangle.height - targetFrame.height)
        return (candidate.0, score)
    }.sorted { $0.1 < $1.1 }
    guard let selected = scored.first, selected.1 <= 12 else {
        throw Failure("could not correlate the focused AX window with an on-screen window")
    }
    return selected.0
}

func screenshotWindow(_ app: NSRunningApplication, window: AXUIElement, output: String) throws {
    let selected = try correlatedWindowID(app, window: window)

    let destination = URL(fileURLWithPath: output).standardizedFileURL
    try FileManager.default.createDirectory(
        at: destination.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    task.arguments = ["-x", "-o", "-l", String(selected), destination.path]
    try task.run()
    task.waitUntilExit()
    guard task.terminationStatus == 0, FileManager.default.fileExists(atPath: destination.path) else {
        throw Failure("screencapture failed with status \(task.terminationStatus)")
    }
    print(destination.path)
}

// Swift screen-recording producer: captures exactly the on-screen window that
// backs the app's focused AX window through ScreenCaptureKit's
// desktop-independent window filter and encodes it to a silent H.264 MP4 with
// AVAssetWriter. There is deliberately no display/region fallback, no audio,
// and no screencapture(1) involvement for video.
@available(macOS 12.3, *)
final class WindowVideoRecorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let queue = DispatchQueue(label: "ui-qa.window-video-recorder")
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private let completed = DispatchSemaphore(value: 0)
    private var stream: SCStream?
    private var duration: Double
    private var sessionStarted = false
    private var stopping = false
    private var failure: String?
    private var firstSourceTime: CMTime?
    private var lastSourceTime: CMTime?
    private var lastPixelBuffer: CVPixelBuffer?
    private var firstFrameUptime: UInt64?

    init(output: URL, width: Int, height: Int, duration: Double) throws {
        writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
        input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
        ])
        input.expectsMediaDataInRealTime = true
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        writer.add(input)
        self.duration = duration
        super.init()
    }

    func start(filter: SCContentFilter, configuration: SCStreamConfiguration) throws {
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        self.stream = stream
        guard writer.startWriting() else {
            throw Failure("could not start the video asset writer: \(writer.error.map { String(describing: $0) } ?? "unknown error")")
        }
        let started = DispatchSemaphore(value: 0)
        var startError: Error?
        stream.startCapture { error in
            startError = error
            started.signal()
        }
        guard started.wait(timeout: .now() + 10) == .success else {
            throw Failure("timed out starting the window capture stream")
        }
        if let startError {
            throw Failure("could not start the window capture stream: \(startError.localizedDescription)")
        }
        // Hard cap enforced inside the helper regardless of caller behavior.
        queue.asyncAfter(deadline: .now() + duration) { self.stopNow() }
    }

    func requestStop() {
        queue.async { self.stopNow() }
    }

    // Blocks until the recording is finalized; returns the failure reason, if any.
    func waitAndFinish() -> String? {
        let margin: Double = 15
        if completed.wait(timeout: .now() + duration + margin) == .timedOut {
            requestStop()
            _ = completed.wait(timeout: .now() + margin)
        }
        return failure
    }

    private func stopNow() {
        guard !stopping else { return }
        stopping = true
        let group = DispatchGroup()
        if let stream {
            group.enter()
            stream.stopCapture { _ in group.leave() }
        }
        group.notify(queue: queue) {
            guard self.sessionStarted else {
                if self.failure == nil { self.failure = "no frames were captured from the target window" }
                self.completed.signal()
                return
            }
            self.appendFinalFrame()
            self.input.markAsFinished()
            self.writer.finishWriting {
                if self.writer.status != .completed, self.failure == nil {
                    self.failure = "video asset writer finished with status \(self.writer.status.rawValue)"
                }
                self.completed.signal()
            }
        }
    }

    private func appendFinalFrame() {
        guard let firstSourceTime, let lastSourceTime, let lastPixelBuffer,
              let firstFrameUptime, input.isReadyForMoreMediaData
        else { return }
        let elapsedNanoseconds = DispatchTime.now().uptimeNanoseconds - firstFrameUptime
        let elapsedSeconds = min(Double(elapsedNanoseconds) / 1_000_000_000, duration)
        var finalTime = CMTimeAdd(
            firstSourceTime,
            CMTime(seconds: elapsedSeconds, preferredTimescale: 600)
        )
        if CMTimeCompare(finalTime, lastSourceTime) <= 0 {
            finalTime = CMTimeAdd(lastSourceTime, CMTime(value: 1, timescale: 15))
        }
        if !adaptor.append(lastPixelBuffer, withPresentationTime: finalTime), failure == nil {
            failure = "video final-frame append failed: \(writer.error.map { String(describing: $0) } ?? "unknown error")"
        }
    }

    private func frameStatus(_ sampleBuffer: CMSampleBuffer) -> SCFrameStatus {
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
            as? [[SCStreamFrameInfo: Any]]
        guard let raw = attachments?.first?[.status] else { return .complete }
        if let status = raw as? SCFrameStatus { return status }
        if let number = raw as? NSNumber, let status = SCFrameStatus(rawValue: number.intValue) { return status }
        return .complete
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen, !stopping else { return }
        let status = frameStatus(sampleBuffer)
        // ScreenCaptureKit marks unchanged-window frames as `idle`; they still
        // carry the current window surface and must be encoded so a static UI
        // produces a truthful non-zero-duration timeline.
        guard status == .complete || status == .started || status == .idle else { return }
        let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if !sessionStarted {
            writer.startSession(atSourceTime: timestamp)
            sessionStarted = true
            firstSourceTime = timestamp
            firstFrameUptime = DispatchTime.now().uptimeNanoseconds
        }
        guard writer.status == .writing, input.isReadyForMoreMediaData,
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer)
        else { return }
        if adaptor.append(pixelBuffer, withPresentationTime: timestamp) {
            lastSourceTime = timestamp
            lastPixelBuffer = pixelBuffer
            return
        }
        if failure == nil {
            failure = "video pixel buffer append failed: \(writer.error.map { String(describing: $0) } ?? "unknown error")"
        }
        stopNow()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        // The captured window or its app died: finalize best-effort. A clean
        // programmatic stopCapture never reaches this callback.
        queue.async {
            if !self.stopping, self.failure == nil {
                self.failure = "capture stream stopped early: \(error.localizedDescription)"
            }
            self.stopNow()
        }
    }
}

private var recorderSignalSources: [DispatchSourceSignal] = []
private let recorderSignalLock = NSLock()
private var activeRecorder: WindowVideoRecorder?
private var recorderStopRequestedStorage = false

private var recorderStopRequested: Bool {
    get {
        recorderSignalLock.lock()
        defer { recorderSignalLock.unlock() }
        return recorderStopRequestedStorage
    }
    set {
        recorderSignalLock.lock()
        recorderStopRequestedStorage = newValue
        recorderSignalLock.unlock()
    }
}

// Installs graceful-stop handling for the record-window command. This must run
// before any slow startup work (app activation, shareable-content
// enumeration), because the desktop backend may legitimately SIGTERM the
// recorder early to stop and finalize.
func installRecorderSignalHandlers() {
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    for number in [SIGTERM, SIGINT] {
        let source = DispatchSource.makeSignalSource(signal: number, queue: DispatchQueue.global())
        source.setEventHandler {
            recorderStopRequested = true
            activeRecorder?.requestStop()
        }
        source.resume()
        recorderSignalSources.append(source)
    }
}

@available(macOS 12.3, *)
func recordWindowVideo(app: NSRunningApplication, window: AXUIElement, arguments: Arguments) throws {
    let windowID = try correlatedWindowID(app, window: window)
    let output = URL(fileURLWithPath: try arguments.required("out")).standardizedFileURL
    try FileManager.default.createDirectory(
        at: output.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    let temporary = URL(fileURLWithPath: "\(output.path).\(ProcessInfo.processInfo.processIdentifier).tmp")

    let semaphore = DispatchSemaphore(value: 0)
    var content: SCShareableContent?
    var enumerationError: Error?
    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { result, error in
        content = result
        enumerationError = error
        semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + 15) == .success else {
        throw Failure("timed out enumerating capturable windows")
    }
    if let enumerationError {
        throw Failure("could not enumerate capturable windows: \(enumerationError.localizedDescription)")
    }
    guard let content, let target = content.windows.first(where: { $0.windowID == windowID }) else {
        throw Failure("window \(windowID) is not present among capturable on-screen windows")
    }

    let requested = try arguments.double("duration", default: 30)
    let duration = min(max(requested, 0.5), 30)
    let windowFrame = try frame(window).unwrap("focused window has no frame")
    let scale = (NSScreen.screens.first { $0.frame.intersects(windowFrame) } ?? NSScreen.main)?.backingScaleFactor ?? 2
    let pixelWidth = evenPixel(Double(windowFrame.width) * scale)
    let pixelHeight = evenPixel(Double(windowFrame.height) * scale)
    let configuration = SCStreamConfiguration()
    configuration.width = pixelWidth
    configuration.height = pixelHeight
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 15)
    configuration.showsCursor = false

    let recorder = try WindowVideoRecorder(
        output: temporary,
        width: pixelWidth,
        height: pixelHeight,
        duration: duration
    )
    activeRecorder = recorder
    try recorder.start(filter: SCContentFilter(desktopIndependentWindow: target), configuration: configuration)
    print("recording-started")
    fflush(stdout)
    if recorderStopRequested { recorder.requestStop() }
    let failure = recorder.waitAndFinish()
    if let failure {
        try? FileManager.default.removeItem(at: temporary)
        throw Failure(failure)
    }
    // Publish atomically: a killed helper can never leave a partial artifact.
    if FileManager.default.fileExists(atPath: output.path) {
        try FileManager.default.removeItem(at: output)
    }
    try FileManager.default.moveItem(at: temporary, to: output)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
    print(output.path)
}

private func evenPixel(_ value: Double) -> Int {
    max(2, (Int(value.rounded(.down)) / 2) * 2)
}

func isUseful(_ element: AXUIElement) -> Bool {
    let usefulRoles: Set<String> = [
        kAXButtonRole, kAXCheckBoxRole, kAXComboBoxRole, "AXLink",
        kAXMenuItemRole, kAXPopUpButtonRole, kAXRadioButtonRole,
        "AXSecureTextField", kAXSliderRole, kAXStaticTextRole,
        kAXTextAreaRole, kAXTextFieldRole, kAXWindowRole,
    ]
    return usefulRoles.contains(role(element)) || !fields(element).isEmpty
}

func run(_ arguments: Arguments) throws {
    switch arguments.command {
    case "doctor":
        let accessibility: Bool
        if arguments.has("prompt") {
            let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            accessibility = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
        } else {
            accessibility = AXIsProcessTrusted()
        }
        let screenRecording = arguments.has("prompt")
            ? CGRequestScreenCaptureAccess()
            : CGPreflightScreenCaptureAccess()
        let screenCaptureKit = ProcessInfo.processInfo.isOperatingSystemAtLeast(
            OperatingSystemVersion(majorVersion: 12, minorVersion: 3, patchVersion: 0)
        )
        print("macos=\(ProcessInfo.processInfo.operatingSystemVersionString)")
        print("accessibility=\(accessibility ? "granted" : "missing")")
        print("screen_recording=\(screenRecording ? "granted" : "missing")")
        print("sck=\(screenCaptureKit ? "available" : "unsupported")")

    case "list":
        for app in NSWorkspace.shared.runningApplications
            .filter({ !$0.isTerminated && $0.activationPolicy == .regular })
            .sorted(by: { ($0.localizedName ?? "") < ($1.localizedName ?? "") })
        {
            print(
                "app=\(quoted(app.localizedName ?? "?")) " +
                    "bundle=\(quoted(app.bundleIdentifier ?? "?")) pid=\(app.processIdentifier)"
            )
        }

    case "wait-window":
        try requireAccessibility()
        let timeout = try arguments.double("timeout", default: 60)
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let app = try? findApplication(arguments), (try? frontWindow(app)) != nil {
                if arguments.has("print-pid") {
                    print(app.processIdentifier)
                } else {
                    print("ready app=\(quoted(app.localizedName ?? "?")) pid=\(app.processIdentifier)")
                }
                return
            }
            usleep(200_000)
        }
        throw Failure("window did not appear within \(timeout)s")

    case "focus":
        try requireAccessibility()
        let app = try findApplication(arguments)
        try activate(app)
        print("focused app=\(quoted(app.localizedName ?? "?")) pid=\(app.processIdentifier)")

    case "inspect":
        try requireAccessibility()
        let app = try findApplication(arguments)
        let window = try frontWindow(app)
        let depth = try arguments.integer("depth", default: 10)
        let limit = try arguments.integer("limit", default: 80)
        var shown = 0
        for located in walk(window, maxDepth: depth) {
            if !arguments.has("all"), !isUseful(located.element) { continue }
            print(summary(located.element, path: located.path))
            shown += 1
            if shown >= limit { break }
        }
        print("shown=\(shown) limit=\(limit) depth=\(depth)")

    case "describe":
        try requireAccessibility()
        let app = try findApplication(arguments)
        let located = try locate(frontWindow(app), arguments: arguments)
        try printJSON(record(located))

    case "screenshot":
        let app = try findApplication(arguments)
        try activate(app)
        let window = try frontWindow(app)
        try screenshotWindow(app, window: window, output: arguments.required("out"))

    case "window-id":
        let app = try findApplication(arguments)
        let window = try frontWindow(app)
        print(try correlatedWindowID(app, window: window))

    case "record-window":
        // Graceful-stop handlers go in before any slow startup work so the
        // desktop backend can always stop and finalize the recorder.
        installRecorderSignalHandlers()
        try requireAccessibility()
        guard #available(macOS 12.3, *) else {
            throw Failure("ScreenCaptureKit window recording requires macOS 12.3 or newer")
        }
        guard CGPreflightScreenCaptureAccess() else {
            throw Failure("Screen Recording permission is required to record a window; run doctor --prompt")
        }
        let app = try findApplication(arguments)
        try activate(app)
        let window = try frontWindow(app)
        try recordWindowVideo(app: app, window: window, arguments: arguments)

    case "click":
        try requireAccessibility()
        let app = try findApplication(arguments)
        try activate(app)
        let located = try locate(frontWindow(app), arguments: arguments)
        let method = try press(located, allowFrameFallback: arguments.has("frame-fallback"))
        print("clicked method=\(method) path=\(located.path) role=\(role(located.element))")

    case "set-value":
        try requireAccessibility()
        let app = try findApplication(arguments)
        try activate(app)
        let located = try locate(frontWindow(app), arguments: arguments)
        var settable = DarwinBoolean(false)
        let check = AXUIElementIsAttributeSettable(
            located.element,
            kAXValueAttribute as CFString,
            &settable
        )
        guard check == .success, settable.boolValue else {
            throw Failure("AX value is not settable for path=\(located.path) role=\(role(located.element))")
        }
        let value = try arguments.required("value")
        let result = AXUIElementSetAttributeValue(
            located.element,
            kAXValueAttribute as CFString,
            value as CFString
        )
        guard result == .success else {
            throw Failure("setting AX value failed: \(result.rawValue)")
        }
        print("set-value path=\(located.path) role=\(role(located.element))")

    case "type":
        try requireAccessibility()
        let app = try findApplication(arguments)
        try activate(app)
        let focused = try focusedElement(app)
        let focusedRole = role(focused)
        let textRoles: Set<String> = [
            kAXComboBoxRole, "AXSecureTextField", kAXTextAreaRole, kAXTextFieldRole,
        ]
        guard textRoles.contains(focusedRole) else {
            throw Failure("refusing to type: focused role is \(focusedRole), not a text input")
        }
        let text = try arguments.required("text")
        try sendText(text)
        print("typed characters=\(text.count) focused_role=\(focusedRole)")

    case "key":
        try requireAccessibility()
        let app = try findApplication(arguments)
        try activate(app)
        let key = try arguments.required("key")
        try sendKey(name: key, modifiers: arguments.value("modifiers"))
        print("key=\(key)")

    case "click-point":
        try requireAccessibility()
        let app = try findApplication(arguments)
        try activate(app)
        let windowFrame = try frame(frontWindow(app)).unwrap("front window has no frame")
        let x = try arguments.double("x")
        let y = try arguments.double("y")
        guard x >= 0, y >= 0, x <= windowFrame.width, y <= windowFrame.height else {
            throw Failure("relative point is outside the front window")
        }
        try clickGlobal(CGPoint(x: windowFrame.minX + x, y: windowFrame.minY + y))
        print("clicked relative=\(Int(x)),\(Int(y))")

    case "quit":
        let app = try findApplication(arguments)
        let requested = arguments.has("force") ? app.forceTerminate() : app.terminate()
        guard requested else { throw Failure("quit request was rejected") }
        print("quit requested pid=\(app.processIdentifier)")

    default:
        throw Failure(Arguments.usage)
    }
}

extension Optional {
    func unwrap(_ message: String) throws -> Wrapped {
        guard let self else { throw Failure(message) }
        return self
    }
}

do {
    try run(Arguments(Array(CommandLine.arguments.dropFirst())))
} catch let error as Failure {
    FileHandle.standardError.write(Data("error: \(error.description)\n".utf8))
    exit(2)
} catch {
    FileHandle.standardError.write(Data("error: \(error)\n".utf8))
    exit(2)
}
