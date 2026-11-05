import Foundation

// Callback-based permission requests cannot dismiss the OS dialog. Stop waiting
// on cancellation; a later answer may change OS authorization, never start audio.
@MainActor
func awaitCapturePermission(_ request: (@escaping (Bool) -> Void) -> Void) async throws {
    let completion = CaptureCompletion()
    try await withTaskCancellationHandler {
        try Task.checkCancellation()
        request { granted in
            Task { @MainActor in
                completion.resolve(granted ? .success(()) : .failure(
                    ProbeFailure("microphone permission denied; no source substitution")))
            }
        }
        try await completion.wait()
        try Task.checkCancellation()
    } onCancel: {
        Task { @MainActor in completion.resolve(.failure(CancellationError())) }
    }
}
