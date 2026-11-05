import AVFoundation
import Foundation
import ScreenCaptureKit

// Writer state and media-time bounds belong to queue, including teardown.
final class AudioSink: NSObject, SCStreamOutput, SCStreamDelegate {
    let queue = DispatchQueue(label: "pix.listener.probe.audio")
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let limit: CMTime
    private var start: CMTime?
    private var end: CMTime?
    private var closed = false
    private var failure: String?
    private var samples = 0

    init(url: URL, seconds: Int) throws {
        guard (1...120).contains(seconds) else { throw ProbeFailure("invalid capture duration") }
        limit = CMTime(value: Int64(seconds), timescale: 1)
        writer = try AVAssetWriter(outputURL: url, fileType: .m4a)
        input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 128000,
        ])
        input.expectsMediaDataInRealTime = true
        super.init()
        guard writer.canAdd(input) else { throw ProbeFailure("audio writer unsupported") }
        writer.add(input)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        if type == .audio { receive(buffer) }
    }

    // Internal entry point also exercised by synthetic PCM tests, without SCStream.
    func receive(_ buffer: CMSampleBuffer) {
        dispatchPrecondition(condition: .onQueue(queue))
        guard !closed, failure == nil else { return }
        do {
            guard let bounded = try boundedBuffer(buffer) else { return }
            if start == nil {
                guard writer.startWriting() else { throw ProbeFailure("writer start failed") }
                let timestamp = CMSampleBufferGetPresentationTimeStamp(bounded)
                writer.startSession(atSourceTime: timestamp)
                start = timestamp
            }
            guard input.isReadyForMoreMediaData, input.append(bounded) else {
                throw ProbeFailure("audio buffer dropped or write failed")
            }
            let count = CMSampleBufferGetNumSamples(bounded)
            samples += count
            end = CMTimeAdd(CMSampleBufferGetPresentationTimeStamp(bounded), CMTime(value: Int64(count), timescale: 48000))
        } catch {
            failure = String(describing: error)
        }
    }

    private func boundedBuffer(_ buffer: CMSampleBuffer) throws -> CMSampleBuffer? {
        let timestamp = CMSampleBufferGetPresentationTimeStamp(buffer)
        let count = CMSampleBufferGetNumSamples(buffer)
        guard CMSampleBufferDataIsReady(buffer), count > 0,
              timestamp.isNumeric, timestamp.epoch == 0,
              let format = CMSampleBufferGetFormatDescription(buffer),
              let audio = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
              audio.mFormatID == kAudioFormatLinearPCM,
              audio.mSampleRate == 48000, audio.mChannelsPerFrame == 2 else {
            throw ProbeFailure("invalid system audio buffer")
        }
        if let end, CMTimeCompare(timestamp, end) < 0 {
            throw ProbeFailure("non-monotonic system audio timestamps")
        }
        let deadline = CMTimeAdd(start ?? timestamp, limit)
        let remaining = CMTimeSubtract(deadline, timestamp)
        guard remaining.isNumeric else { throw ProbeFailure("invalid system audio timeline") }
        // Round down so not even a partial sample can cross the media deadline.
        let frames = CMTimeConvertScale(remaining, timescale: 48000, method: .roundTowardNegativeInfinity).value
        guard frames > 0 else { return nil }
        let allowed = min(Int64(count), frames)
        if allowed == count { return buffer }
        var clipped: CMSampleBuffer?
        let status = CMSampleBufferCopySampleBufferForRange(allocator: kCFAllocatorDefault, sampleBuffer: buffer,
            sampleRange: CFRange(location: 0, length: Int(allowed)), sampleBufferOut: &clipped)
        guard status == noErr, let clipped else { throw ProbeFailure("audio boundary clipping failed") }
        return clipped
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { if !self.closed { self.failure = "system capture interrupted" } }
    }

    func finish() async throws -> Int {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                guard !self.closed else {
                    continuation.resume(throwing: ProbeFailure("audio writer already closed"))
                    return
                }
                self.closed = true
                if let failure = self.failure {
                    self.writer.cancelWriting()
                    continuation.resume(throwing: ProbeFailure(failure))
                } else if let end = self.end, self.samples > 0 {
                    self.writer.endSession(atSourceTime: end)
                    self.input.markAsFinished()
                    self.writer.finishWriting {
                        self.queue.async {
                            if self.writer.status == .completed {
                                continuation.resume(returning: self.samples)
                            } else {
                                continuation.resume(throwing: ProbeFailure("audio finalization failed"))
                            }
                        }
                    }
                } else {
                    self.writer.cancelWriting()
                    continuation.resume(throwing: ProbeFailure("no system audio samples received"))
                }
            }
        }
    }

    func cancel() async {
        await withCheckedContinuation { continuation in
            queue.async {
                self.closed = true
                self.failure = "cancelled"
                self.writer.cancelWriting()
                continuation.resume()
            }
        }
    }
}

func validateSystemCapture(url: URL, seconds: Int) async throws -> Double {
    let asset = AVURLAsset(url: url)
    let duration = try await asset.load(.duration).seconds
    let audio = try AVAudioFile(forReading: url)
    let decodedDuration = Double(audio.length) / audio.processingFormat.sampleRate
    guard duration.isFinite, duration > 0, duration <= Double(seconds),
          decodedDuration.isFinite, decodedDuration > 0, decodedDuration <= Double(seconds) else {
        throw ProbeFailure("system capture duration outside requested bound")
    }
    return decodedDuration
}
