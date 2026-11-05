// Synthetic PCM only: never constructs SCStream or requests capture permissions.
import AVFoundation
import Foundation

struct ProbeFailure: Error { let message: String; init(_ message: String) { self.message = message } }
func emit(_ value: [String: Any]) throws {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value))
}

func pcm(frames: Int, timestamp: CMTime, rate: Double = 48000) throws -> CMSampleBuffer {
    var description = AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
        mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 2,
        mBitsPerChannel: 16, mReserved: 0)
    var format: CMAudioFormatDescription?
    guard CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &description,
        layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil,
        formatDescriptionOut: &format) == noErr else { throw ProbeFailure("fixture format") }
    var block: CMBlockBuffer?
    let bytes = frames * 4
    guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil,
        blockLength: bytes, blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
        offsetToData: 0, dataLength: bytes, flags: 0, blockBufferOut: &block) == noErr,
        let block,
        CMBlockBufferFillDataBytes(with: 0, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes) == noErr
        else { throw ProbeFailure("fixture block") }
    var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: Int32(rate)),
        presentationTimeStamp: timestamp, decodeTimeStamp: .invalid)
    var size = 4
    var buffer: CMSampleBuffer?
    guard CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block,
        formatDescription: format, sampleCount: frames, sampleTimingEntryCount: 1,
        sampleTimingArray: &timing, sampleSizeEntryCount: 1, sampleSizeArray: &size,
        sampleBufferOut: &buffer) == noErr, let buffer else { throw ProbeFailure("fixture buffer") }
    return buffer
}

@main struct Driver {
    static func main() async throws {
        let mode = CommandLine.arguments[1]
        let seconds = Int(CommandLine.arguments[2])!
        let url = URL(fileURLWithPath: CommandLine.arguments[3])
        let sink = try AudioSink(url: url, seconds: mode == "validate-overrun" ? 2 : seconds)
        // Large nonzero source PTS catches accidental use of absolute wall/media time.
        let origin = CMTime(value: 900_000_000, timescale: 48000)
        var buffers: [CMSampleBuffer] = []
        switch mode {
        case "overrun":
            buffers = [try pcm(frames: seconds * 48000 + 30702, timestamp: origin),
                       try pcm(frames: 1024, timestamp: CMTimeAdd(origin, CMTime(value: Int64(seconds + 1), timescale: 1)))]
        case "crossing":
            buffers = [try pcm(frames: 47000, timestamp: origin),
                       try pcm(frames: 2048, timestamp: CMTimeAdd(origin, CMTime(value: 47000, timescale: 48000)))]
        case "short":
            buffers = [try pcm(frames: 24000, timestamp: origin)]
        case "late-gap":
            buffers = [try pcm(frames: 24000, timestamp: origin),
                       try pcm(frames: 1024, timestamp: CMTimeAdd(origin, CMTime(value: 2, timescale: 1)))]
        case "validate-overrun":
            buffers = [try pcm(frames: 96000, timestamp: origin)]
        case "overlap":
            buffers = [try pcm(frames: 24000, timestamp: origin), try pcm(frames: 24000, timestamp: origin)]
        case "invalid-time":
            buffers = [try pcm(frames: 1024, timestamp: .invalid)]
        case "wrong-format":
            buffers = [try pcm(frames: 1024, timestamp: origin, rate: 44100)]
        case "cancel", "empty": break
        default: throw ProbeFailure("unknown fixture mode")
        }
        for buffer in buffers { sink.queue.sync { sink.receive(buffer) } }
        if mode == "cancel" {
            await sink.cancel()
            let stale = try pcm(frames: 48000, timestamp: origin)
            sink.queue.sync { sink.receive(stale) }
        }
        let expectFailure = ["overlap", "invalid-time", "wrong-format", "cancel", "empty"].contains(mode)
        let samples: Int
        do {
            samples = try await sink.finish()
        } catch {
            guard expectFailure else { throw error }
            try emit(["rejected": true])
            return
        }
        guard !expectFailure else { throw ProbeFailure("expected rejection") }
        if mode == "validate-overrun" {
            do {
                _ = try await validateSystemCapture(url: url, seconds: seconds)
            } catch {
                try emit(["rejected": true])
                return
            }
            throw ProbeFailure("overlong encoded output passed validation")
        }
        let expected = ["short", "late-gap"].contains(mode) ? 24000 : seconds * 48000
        guard samples == expected else { throw ProbeFailure("wrong retained sample count: \(samples)") }
        // A late callback must not reopen or append to a finalized writer.
        let late = try pcm(frames: 1024, timestamp: origin)
        sink.queue.sync { sink.receive(late) }
        do {
            _ = try await sink.finish()
            throw ProbeFailure("duplicate finish succeeded")
        } catch let error as ProbeFailure {
            guard error.message == "audio writer already closed" else { throw error }
        }
        _ = try await validateSystemCapture(url: url, seconds: seconds)
        try await decodeAudio(input: url.path, output: url.path + ".pcm")
    }
}
