import AVFoundation
import Foundation

// A non-integral number of 16-kHz output frames, using real synthetic PCM/AAC.
func fractionalReferenceCase(_ mode: String, directory: URL) async throws {
    let rate = Int(mode.split(separator: "-").last!)!
    let channels = rate == 96000 || mode.contains("-stereo-") ? 2 : 1
    let frames = rate + 1
    let aac = mode.contains("-aac-")
    let source = directory.appendingPathComponent(aac ? "source.m4a" : "source.wav")
    do {
        var settings: [String: Any] = [
            AVFormatIDKey: aac ? kAudioFormatMPEG4AAC : kAudioFormatLinearPCM,
            AVSampleRateKey: rate, AVNumberOfChannelsKey: channels,
        ]
        if !aac {
            settings[AVLinearPCMBitDepthKey] = 16
            settings[AVLinearPCMIsFloatKey] = false
        }
        let audio = try AVAudioFile(forWriting: source, settings: settings)
        let buffer = AVAudioPCMBuffer(pcmFormat: audio.processingFormat, frameCapacity: AVAudioFrameCount(frames))!
        buffer.frameLength = AVAudioFrameCount(frames)
        for channel in 0..<channels { buffer.floatChannelData![channel].initialize(repeating: 0, count: frames) }
        try audio.write(from: buffer)
    }
    let reference = try AVAudioFile(forReading: source)
    try require(reference.length == frames && reference.fileFormat.sampleRate == Double(rate), "fractional reference changed")
    let output = directory.appendingPathComponent("output.pcm")
    try await decodeAudio(input: source.path, output: output.path)
    let count = try FileManager.default.attributesOfItem(atPath: output.path)[.size] as! NSNumber
    let outputFrames = count.int64Value / 2
    let maximumFrames = (Int64(frames) * 16000 + Int64(rate) - 1) / Int64(rate)
    try require(count.int64Value % 2 == 0 && outputFrames <= maximumFrames, "excess beyond final frame rounding")
    let actual = CMTime(value: outputFrames, timescale: 16000)
    let exact = CMTime(value: Int64(frames), timescale: Int32(rate))
    try require(CMTimeAdd(actual, CMTime(value: 1, timescale: 1000)) >= exact, "fractional deficit exceeded 1ms")
}
