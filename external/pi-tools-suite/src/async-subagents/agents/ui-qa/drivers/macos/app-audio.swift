import AVFoundation
import CoreMedia
import Foundation

// ScreenCaptureKit's single-window filter supplies the owning application's
// audio (including its other windows), never a window-specific audio track.
final class AppAudioTrack {
    let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: 48_000,
        AVNumberOfChannelsKey: 2,
        AVEncoderBitRateKey: 128_000,
    ])
    private(set) var buffers = 0
    private(set) var failure: String?

    init(writer: AVAssetWriter) throws {
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw Failure("cannot add app audio to window recorder") }
        writer.add(input)
    }

    func append(_ sample: CMSampleBuffer, start: CMTime?, writer: AVAssetWriter) {
        guard failure == nil, let start, CMSampleBufferIsValid(sample),
              CMSampleBufferDataIsReady(sample),
              CMTimeCompare(CMSampleBufferGetPresentationTimeStamp(sample), start) >= 0 else { return }
        guard let format = CMSampleBufferGetFormatDescription(sample),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format),
              asbd.pointee.mSampleRate == 48_000, asbd.pointee.mChannelsPerFrame == 2 else {
            failure = "unexpected app audio format"; return
        }
        guard writer.status == .writing, input.isReadyForMoreMediaData else {
            failure = "app audio encoder backpressure or writer failure"; return
        }
        if input.append(sample) { buffers += 1 }
        else { failure = "app audio append failed" }
    }

    var evidence: String {
        if let failure { return "app-audio=unavailable reason=\(failure)" }
        if buffers == 0 { return "app-audio=unavailable reason=no audio buffers captured" }
        return "app-audio=recorded buffers=\(buffers)"
    }
}
