import AVFoundation
import CoreGraphics
import Foundation
import ScreenCaptureKit

func captureAudio(seconds: Int, output: String) async throws {
    // Only the explicit capture subcommand reaches this branch. No permission requests on inspect.
    try confirmSystemCapture(seconds: seconds)
    guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
        throw ProbeFailure("screen/system-audio permission denied; grant access explicitly and rerun")
    }
    let files = FileManager.default
    let destination = URL(fileURLWithPath: output).standardizedFileURL
    guard !files.fileExists(atPath: destination.path) else { throw ProbeFailure("output already exists") }
    let partial = destination.deletingLastPathComponent().appendingPathComponent(".capture-\(UUID().uuidString).m4a")
    defer { try? files.removeItem(at: partial) }
    let lifetime = CaptureLifetime(seconds: seconds, partial: partial)
    defer { lifetime.close() }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    try lifetime.checkActive()
    guard let display = content.displays.first else { throw ProbeFailure("no display for system-mix filter") }
    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.excludesCurrentProcessAudio = false
    config.sampleRate = 48000
    config.channelCount = 2
    // SCStream has a visual pipeline even with no screen output attached. Minimize
    // its unused frames; never expose, consume or save them as video.
    config.width = 2
    config.height = 2
    config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    config.showsCursor = false
    let sink = try AudioSink(url: partial, seconds: seconds)
    let stream = SCStream(filter: filter, configuration: config, delegate: sink)
    // Only an audio consumer is attached: no video file or microphone input.
    try stream.addStreamOutput(sink, type: .audio, sampleHandlerQueue: sink.queue)
    let recording = lifetime.start {
        try await stream.startCapture()
        FileHandle.standardError.write(Data("RECORDING GENERAL SYSTEM AUDIO (no microphone/video); Ctrl-C cancels.\n".utf8))
        try await Task.sleep(nanoseconds: UInt64(seconds) * 1_000_000_000)
    }
    do {
        try await recording.value
        try await stream.stopCapture()
        let samples = try await sink.finish()
        let duration = try await validateSystemCapture(url: partial, seconds: seconds)
        try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: partial.path)
        try lifetime.publish { try files.moveItem(at: partial, to: destination) }
        try emit(["audioSamples": samples, "durationSeconds": duration, "requestedSeconds": seconds, "videoOutputs": 0, "internalFrames": "minimized-2x2-1fps-not-consumed", "microphone": false])
    } catch {
        try? await stream.stopCapture()
        await sink.cancel()
        throw error
    }
}
