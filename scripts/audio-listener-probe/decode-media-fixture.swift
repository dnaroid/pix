import AVFoundation
import Foundation

private func silentPCM() throws -> CMSampleBuffer {
    let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 48000, channels: 1, interleaved: true)!
    var description: CMAudioFormatDescription?
    try require(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: format.streamDescription,
        layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil,
        formatDescriptionOut: &description) == noErr, "PCM format")
    var block: CMBlockBuffer?
    try require(CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil,
        blockLength: 96000, blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
        offsetToData: 0, dataLength: 96000, flags: 0, blockBufferOut: &block) == noErr, "PCM allocation")
    try require(CMBlockBufferFillDataBytes(with: 0, blockBuffer: block!, offsetIntoDestination: 0, dataLength: 96000) == noErr, "PCM silence")
    var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48000), presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
    var size = 2
    var sample: CMSampleBuffer?
    try require(CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block,
        formatDescription: description, sampleCount: 48000, sampleTimingEntryCount: 1,
        sampleTimingArray: &timing, sampleSizeEntryCount: 1, sampleSizeArray: &size,
        sampleBufferOut: &sample) == noErr, "PCM sample")
    return sample!
}

// Generate a 3-second silent black video with one ~1-second AAC audio track.
// No ffmpeg, device, permission request, network or checked-in binary fixture.
func videoReferenceCase(directory: URL, inconsistentMetadata: Bool) async throws {
    let audioURL = directory.appendingPathComponent("source.m4a")
    if inconsistentMetadata {
        let audio = try AVAudioFile(forWriting: audioURL, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64000,
        ])
        let frames: AVAudioFrameCount = 48000
        let buffer = AVAudioPCMBuffer(pcmFormat: audio.processingFormat, frameCapacity: frames)!
        buffer.frameLength = frames
        for channel in 0..<Int(buffer.format.channelCount) {
            buffer.floatChannelData![channel].initialize(repeating: 0, count: Int(frames))
        }
        try audio.write(from: buffer)
    }
    let videoURL = directory.appendingPathComponent("video.mp4")
    let writer = try AVAssetWriter(outputURL: videoURL, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 16, AVVideoHeightKey: 16,
    ])
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
        kCVPixelBufferWidthKey as String: 16, kCVPixelBufferHeightKey as String: 16,
    ])
    writer.add(input)
    let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 1,
    ])
    if !inconsistentMetadata { writer.add(audioInput) }
    try require(writer.startWriting(), "video writer start")
    writer.startSession(atSourceTime: .zero)
    if !inconsistentMetadata {
        for _ in 0..<500 where !audioInput.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 10_000_000) }
        try require(audioInput.isReadyForMoreMediaData, "audio writer blocked")
        let silence = try silentPCM()
        try require(audioInput.append(silence), "audio append")
        audioInput.markAsFinished()
    }
    var pixel: CVPixelBuffer?
    try require(CVPixelBufferCreate(kCFAllocatorDefault, 16, 16, kCVPixelFormatType_32ARGB, nil, &pixel) == kCVReturnSuccess,
        "pixel allocation")
    let frame = pixel!
    CVPixelBufferLockBaseAddress(frame, [])
    memset(CVPixelBufferGetBaseAddress(frame), 0, CVPixelBufferGetDataSize(frame))
    CVPixelBufferUnlockBaseAddress(frame, [])
    for second in [0, 2] {
        for _ in 0..<500 where !input.isReadyForMoreMediaData {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        try require(input.isReadyForMoreMediaData, "video writer blocked")
        try require(adaptor.append(frame, withPresentationTime: CMTime(value: Int64(second), timescale: 1)), "video append")
    }
    writer.endSession(atSourceTime: CMTime(value: 3, timescale: 1))
    input.markAsFinished()
    await writer.finishWriting()
    try require(writer.status == .completed, "video writer failed")
    var movie = videoURL
    if inconsistentMetadata {
        let composition = AVMutableComposition()
        for (url, type) in [(audioURL, AVMediaType.audio), (videoURL, AVMediaType.video)] {
            let asset = AVURLAsset(url: url)
            let track = try await asset.loadTracks(withMediaType: type)[0]
            let target = composition.addMutableTrack(withMediaType: type, preferredTrackID: kCMPersistentTrackID_Invalid)!
            try target.insertTimeRange(try await track.load(.timeRange), of: track, at: .zero)
        }
        movie = directory.appendingPathComponent("longer-video.mp4")
        let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough)!
        export.outputURL = movie
        export.outputFileType = .mp4
        await export.export()
        try require(export.status == .completed, "video export failed")
    }
    let asset = AVURLAsset(url: movie)
    let containerDuration = try await asset.load(.duration).seconds
    try require(containerDuration >= 3, "video fixture too short")
    let audio = try AVAudioFile(forReading: movie)
    let reference = Double(audio.length) / audio.fileFormat.sampleRate
    try require(reference >= 0.999 && reference <= 1.01, "audio fixture wrong duration")
    let output = directory.appendingPathComponent("output.pcm")
    if inconsistentMetadata {
        var rejected = false
        do { try await decodeAudio(input: movie.path, output: output.path) }
        catch let error as ProbeFailure {
            rejected = error.description == "audio timeline disagrees with exact frame reference"
        }
        try require(rejected, "inconsistent remux was not rejected")
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        try require(!names.contains("output.pcm") && !names.contains { $0.hasPrefix(".decode-") }, "inconsistent remux published")
        return
    }
    try await decodeAudio(input: movie.path, output: output.path)
    let count = try FileManager.default.attributesOfItem(atPath: output.path)[.size] as! NSNumber
    let seconds = count.doubleValue / 32000
    try require(seconds <= reference && seconds >= reference - 0.001, "decoded against wrong timeline")
}
