import AppKit
import ApplicationServices
import Darwin
import Foundation

// Paired releases on normal/cooperative exit; SIGKILL cannot run cleanup.
// PID delivery is default. Explicit foreground delivery uses system events:
// focus checks reduce but cannot eliminate the check/post race.
func gameInput(app: NSRunningApplication, arguments: Arguments) throws {
    let delivery = arguments.value("delivery") ?? "pid"
    guard delivery == "pid" || delivery == "foreground" else { throw Failure("invalid game input delivery") }
    let foreground = delivery == "foreground"
    let duration = try arguments.double("duration", default: 0.1)
    let dx = try arguments.integer("dx", default: 0)
    let dy = try arguments.integer("dy", default: 0)
    let names = (arguments.value("keys") ?? "").split(separator: ",").map(String.init)
    guard duration.isFinite, duration >= 0.02, duration <= 5,
          (-2000...2000).contains(dx), (-2000...2000).contains(dy),
          names.count <= 8, Set(names).count == names.count else {
        throw Failure("invalid bounded game input")
    }
    let extra: [String: CGKeyCode] = ["shift": 56, "ctrl": 59,
        "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23,
        "6": 22, "7": 26, "8": 28, "9": 25]
    let codes = try names.map { name in try extra[name] ?? keyCode(name) }
    guard Set(codes).count == codes.count else { throw Failure("duplicate key codes") }
    let buttonName = arguments.value("button")
    guard buttonName == nil || buttonName == "left" || buttonName == "right" else { throw Failure("invalid game button") }
    let window = try frontWindow(app)
    let windowID = try correlatedWindowID(app, window: window)
    let rectangle = try frame(window).unwrap("game window has no frame")
    let point = CGPoint(x: rectangle.midX, y: rectangle.midY)
    func targetPointer(_ event: CGEvent) {
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowID))
    }
    var flags: CGEventFlags = []
    if names.contains("shift") { flags.insert(.maskShift) }
    if names.contains("ctrl") { flags.insert(.maskControl) }
    var downs: [CGEvent] = []
    var ups: [CGEvent] = []
    // Create all pairs before posting anything; allocation failures cannot strand input.
    for code in codes {
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
            throw Failure("could not create game key events")
        }
        if code == 56 || code == 59 { down.type = .flagsChanged; up.type = .flagsChanged }
        down.flags = flags
        up.flags = []
        downs.append(down); ups.append(up)
    }
    if let buttonName {
        let right = buttonName == "right"
        guard let down = CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseDown : .leftMouseDown, mouseCursorPosition: point, mouseButton: right ? .right : .left),
              let up = CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: point, mouseButton: right ? .right : .left) else {
            throw Failure("could not create game button events")
        }
        down.flags = flags
        targetPointer(down); targetPointer(up)
        downs.append(down); ups.append(up)
    }
    let stop = GameInputCancellation()
    let sources = stop.install()
    defer { for source in sources { source.cancel() } }
    let parent = getppid()
    func check() throws {
        guard !stop.requested, getppid() == parent, !app.isTerminated,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
            throw Failure("game input cancelled: signal, parent exit, target exit or focus loss")
        }
    }
    func post(_ event: CGEvent) {
        if foreground { event.post(tap: .cghidEventTap) }
        else { event.postToPid(app.processIdentifier) }
    }
    try check()
    if foreground {
        guard !codes.contains(where: { CGEventSource.keyState(.combinedSessionState, key: $0) }),
              buttonName == nil || !CGEventSource.buttonState(.combinedSessionState, button: buttonName == "right" ? .right : .left) else {
            throw Failure("refusing foreground input: requested key or button is already held")
        }
    }
    if buttonName != nil {
        // AppKit/Godot tracks whether the cursor entered the content view. PID
        // delivery alone does not update that tracking when the cursor is elsewhere.
        guard CGWarpMouseCursorPosition(point) == .success,
              let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
            throw Failure("could not position game pointer")
        }
        targetPointer(move)
        try check()
        post(move)
        usleep(20_000)
        try check()
    }
    var pressed = 0
    // Release only our posted downs, even when focus is lost halfway through.
    // System releases must still reach the HID stream after cancellation.
    defer { for event in ups.prefix(pressed).reversed() { post(event) } }
    for event in downs {
        try check()
        post(event)
        pressed += 1
    }
    let started = ProcessInfo.processInfo.systemUptime
    var sentX = 0
    var sentY = 0
    repeat {
        try check()
        let fraction = min(1, (ProcessInfo.processInfo.systemUptime - started) / duration)
        let x = Int((Double(dx) * fraction).rounded())
        let y = Int((Double(dy) * fraction).rounded())
        if x != sentX || y != sentY {
            guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
                throw Failure("could not create game pointer event")
            }
            move.flags = flags
            targetPointer(move)
            move.setIntegerValueField(.mouseEventDeltaX, value: Int64(x - sentX))
            move.setIntegerValueField(.mouseEventDeltaY, value: Int64(y - sentY))
            try check()
            post(move)
            sentX = x; sentY = y
        }
        if fraction >= 1 { break }
        usleep(10_000)
    } while true
    print("game-input completed; input released on return")
}

private final class GameInputCancellation {
    private let lock = NSLock()
    private var stopped = false
    var requested: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
    func install() -> [DispatchSourceSignal] {
        [SIGTERM, SIGINT].map { number in
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
            source.setEventHandler { self.lock.lock(); self.stopped = true; self.lock.unlock() }
            source.resume()
            return source
        }
    }
}
