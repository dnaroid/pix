import Foundation

// Prototype process boundary: a stuck framework must not leave capture running.
// Hard termination unlinks the private partial file; the OS tears down SCStream.
final class CaptureLifetime {
    static func watchdogSeconds(for seconds: Int) -> Int { seconds + 15 }
    private let lock = NSLock()
    private let partial: URL
    private let seconds: Int
    private var watchdogArmed = false
    private var task: Task<Void, Error>?
    private var cancelled = false
    private var committed = false
    private var closed = false
    private var signals: [DispatchSourceSignal] = []
    private let timer: DispatchSourceTimer

    init(seconds: Int, partial: URL, deadline: DispatchTime? = nil, awaitingPermission: Bool = false) {
        self.partial = partial
        self.seconds = seconds
        let queue = DispatchQueue(label: "pix.listener.probe.watchdog")
        timer = DispatchSource.makeTimerSource(queue: queue)
        for number in [SIGINT, SIGTERM, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
            source.setEventHandler { [weak self] in self?.cancel() }
            signals.append(source)
            source.resume()
        }
        timer.setEventHandler { [weak self] in self?.terminate() }
        if !awaitingPermission {
            watchdogArmed = true
            timer.schedule(deadline: deadline ?? .now() + .seconds(Self.watchdogSeconds(for: seconds)))
        }
        timer.resume()
    }

    func armWatchdog(deadline: DispatchTime? = nil) throws {
        lock.lock()
        defer { lock.unlock() }
        if cancelled || closed || committed { throw CancellationError() }
        guard !watchdogArmed else { return }
        watchdogArmed = true
        timer.schedule(deadline: deadline ?? .now() + .seconds(Self.watchdogSeconds(for: seconds)))
    }

    func start(_ operation: @escaping () async throws -> Void) -> Task<Void, Error> {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return Task { throw CancellationError() } }
        let task = Task {
            try self.checkActive()
            try await operation()
        }
        self.task = task
        return task
    }

    func checkActive() throws {
        lock.lock()
        defer { lock.unlock() }
        if cancelled || closed { throw CancellationError() }
    }

    func publish(_ operation: () throws -> Void) throws {
        lock.lock()
        defer { lock.unlock() }
        if cancelled || closed { throw CancellationError() }
        try operation()
        committed = true
        timer.cancel()
    }

    func cancel() {
        lock.lock()
        if committed || closed { lock.unlock(); return }
        let alreadyCancelled = cancelled
        cancelled = true
        // Permission wait has no recording deadline, but cancellation must
        // still have a bounded escape if cooperative teardown stalls.
        if !watchdogArmed {
            watchdogArmed = true
            timer.schedule(deadline: .now() + .seconds(15))
        }
        let task = self.task
        lock.unlock()
        if alreadyCancelled { terminate() }
        task?.cancel()
    }

    func terminate() {
        // Do not wait on the writer's queue: it may be the reason for the timeout.
        // Serialize only with the final publication, never with media processing.
        lock.lock()
        if committed || closed { lock.unlock(); return }
        cancelled = true
        lock.unlock()
        unlink(partial.path)
        _exit(124)
    }

    func close() {
        lock.lock()
        guard !closed else { lock.unlock(); return }
        closed = true
        let task = self.task
        self.task = nil
        lock.unlock()
        // Source cancellation does not retract an already queued callback.
        // Mark the owner closed first; cancel owned work outside the lock.
        timer.cancel()
        signals.forEach { $0.cancel() }
        task?.cancel()
        for number in [SIGINT, SIGTERM, SIGHUP] { signal(number, SIG_DFL) }
    }
}

func confirmSystemCapture(seconds: Int) throws {
    guard isatty(STDIN_FILENO) == 1, isatty(STDERR_FILENO) == 1 else {
        throw ProbeFailure("capture requires an interactive terminal and typed user confirmation")
    }
    FileHandle.standardError.write(Data("Record ALL system audio for \(seconds)s, including other apps and notifications? No microphone or video file. Type RECORD SYSTEM AUDIO to proceed: ".utf8))
    guard readLine() == "RECORD SYSTEM AUDIO" else { throw ProbeFailure("capture not confirmed") }
}
