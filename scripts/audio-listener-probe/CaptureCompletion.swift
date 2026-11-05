import Foundation

// One terminal outcome, including cancellation before a delegate starts waiting.
// Main-actor serialization keeps recorder callbacks and cancellation ordered.
@MainActor
final class CaptureCompletion {
    private var outcome: Result<Void, Error>?
    private var continuation: CheckedContinuation<Void, Error>?
    private var waiting = false

    func resolve(_ result: Result<Void, Error>) {
        guard outcome == nil else { return }
        outcome = result
        let pending = continuation
        continuation = nil
        pending?.resume(with: result)
    }

    func wait() async throws {
        precondition(!waiting, "only one recording waiter is supported")
        waiting = true
        if let outcome { return try outcome.get() }
        try await withCheckedThrowingContinuation { continuation = $0 }
    }
}
