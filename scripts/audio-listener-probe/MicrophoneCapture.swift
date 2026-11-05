import AVFoundation
import Foundation

// Development probe only. Uses the user's default audio input, never switches
// devices or falls back to system audio. PCM CAF avoids AAC padding at the limit.
@MainActor
private final class MicrophoneRecorder: NSObject, AVAudioRecorderDelegate {
    private let recorder: AVAudioRecorder
    private let completion = CaptureCompletion()

    init(url: URL) throws {
        recorder = try AVAudioRecorder(url: url, settings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ])
        super.init()
        recorder.delegate = self
    }

    func record(seconds: Int) async throws {
        defer {
            recorder.delegate = nil
            recorder.stop()
        }
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            guard recorder.record(forDuration: Double(seconds)) else {
                throw ProbeFailure("microphone recorder could not start")
            }
            FileHandle.standardError.write(Data("RECORDING DEFAULT MICROPHONE INPUT (no system capture/video); Ctrl-C cancels.\n".utf8))
            try await completion.wait()
            try Task.checkCancellation()
        } onCancel: {
            Task { @MainActor in
                self.completion.resolve(.failure(CancellationError()))
                self.recorder.stop()
            }
        }
    }

    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor in
            completion.resolve(flag ? .success(()) : .failure(ProbeFailure("microphone recording interrupted")))
        }
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        Task { @MainActor in
            completion.resolve(.failure(ProbeFailure("microphone recording failed")))
        }
    }
}

func captureMicrophone(seconds: Int, output: String, confirmation: (() throws -> Void)? = nil) async throws {
    if let confirmation { try confirmation() }
    else { try confirmMicrophoneCapture(seconds: seconds) }
    let files = FileManager.default
    let destination = URL(fileURLWithPath: output).standardizedFileURL
    guard !files.fileExists(atPath: destination.path) else { throw ProbeFailure("output already exists") }
    let partial = destination.deletingLastPathComponent().appendingPathComponent(".microphone-\(UUID().uuidString).caf")
    defer { try? files.removeItem(at: partial) }
    let lifetime = CaptureLifetime(seconds: seconds, partial: partial, awaitingPermission: true)
    defer { lifetime.close() }
    let recording = lifetime.start {
        try await awaitCapturePermission { reply in
            AVCaptureDevice.requestAccess(for: .audio, completionHandler: reply)
        }
        try lifetime.armWatchdog()
        guard AVCaptureDevice.default(for: .audio) != nil else { throw ProbeFailure("no default microphone input") }
        let recorder = try await MicrophoneRecorder(url: partial)
        try await recorder.record(seconds: seconds)
    }
    try await recording.value
    try lifetime.checkActive()
    // Fail closed on interrupted or overlong recordings; never publish an
    // unverified duration just because the framework reported successful stop.
    let audio = try AVAudioFile(forReading: partial)
    let duration = Double(audio.length) / audio.processingFormat.sampleRate
    guard duration.isFinite, duration > 0,
          duration >= Double(seconds) - 0.05,
          duration <= Double(seconds) else {
        throw ProbeFailure("microphone duration outside requested bound")
    }
    try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: partial.path)
    try lifetime.publish { try files.moveItem(at: partial, to: destination) }
    try emit(["durationSeconds": duration, "requestedSeconds": seconds, "source": "microphone", "systemCapture": false, "videoOutputs": 0])
}

func confirmMicrophoneCapture(seconds: Int) throws {
    guard isatty(STDIN_FILENO) == 1, isatty(STDERR_FILENO) == 1 else {
        throw ProbeFailure("microphone capture requires an interactive terminal and typed user confirmation")
    }
    FileHandle.standardError.write(Data("Record the DEFAULT AUDIO INPUT for \(seconds)s? Check that your chosen input is a microphone, not a virtual loopback. No system capture or video. Type RECORD MICROPHONE to proceed: ".utf8))
    guard readLine() == "RECORD MICROPHONE" else { throw ProbeFailure("microphone capture not confirmed") }
}
