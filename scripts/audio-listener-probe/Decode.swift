import AVFoundation
import Foundation

// AVAssetReader streams decoded mono PCM16 at 16kHz without FFmpeg or whole-file buffers.
// Phase-one probe intentionally rejects multi-track and >120s files; ranges come later.
func decodeAudio(input: String, output: String) async throws {
    let files = FileManager.default
    let source = URL(fileURLWithPath: input).resolvingSymlinksInPath()
    let destination = URL(fileURLWithPath: output).standardizedFileURL
    let attributes = try files.attributesOfItem(atPath: source.path)
    guard attributes[.type] as? FileAttributeType == .typeRegular,
          let size = attributes[.size] as? NSNumber, size.uint64Value <= 512 * 1024 * 1024 else {
        throw ProbeFailure("input must be a regular file of at most 512 MiB")
    }
    guard !files.fileExists(atPath: destination.path) else { throw ProbeFailure("output already exists") }
    let asset = AVURLAsset(url: source)
    let duration = try await asset.load(.duration).seconds
    guard duration.isFinite, duration > 0, duration <= 120 else {
        throw ProbeFailure("input duration must be between 0 and 120 seconds")
    }
    let tracks = try await asset.loadTracks(withMediaType: .audio)
    guard tracks.count == 1 else { throw ProbeFailure("probe requires exactly one audio track") }
    let audioTrack = tracks[0]
    let range = try await audioTrack.load(.timeRange)
    let segments = try await audioTrack.load(.segments)
    let timelineDuration = try decodeTimelineDuration(range: range, segments: segments)
    try Task.checkCancellation()
    let expected = try decodeFrameReference(source: source, timelineDuration: timelineDuration)
    let total = try publishDecodedPCM(destination: destination, expectedDuration: expected) { handle in
        try checkDecodeSource(source, attributes: attributes)
        let bytes = try decodePCM(asset: asset, audioTrack: audioTrack, handle: handle)
        try checkDecodeSource(source, attributes: attributes)
        return bytes
    }
    try emit(["sampleRate": 16000, "channels": 1, "format": "s16le", "bytes": total, "durationSeconds": Double(total) / 32000])
}

// Reject gaps/empty edits/time scaling rather than inventing silence. Metadata
// is a cross-check, NOT the PCM reference: AVFoundation's AAC edit
// duration can exclude priming even when its PCM output includes that interval.
func decodeTimelineDuration(range: CMTimeRange, segments: [AVAssetTrackSegment]) throws -> CMTime {
    guard range.isValid, range.start.isNumeric, range.duration.isNumeric,
          range.start.epoch == 0, range.duration.epoch == 0,
          range.start >= .zero, range.duration > .zero,
          range.duration <= CMTime(value: 120, timescale: 1), segments.count == 1 else {
        throw ProbeFailure("unsupported audio track duration")
    }
    var end = range.start
    for segment in segments {
        let mapping = segment.timeMapping
        guard !segment.isEmpty, mapping.source.isValid, mapping.target.isValid,
              mapping.source.start.isNumeric, mapping.source.start >= .zero,
              mapping.source.start.epoch == 0, mapping.source.duration.epoch == 0,
              mapping.target.start.epoch == 0, mapping.target.duration.epoch == 0,
              mapping.source.duration.isNumeric, mapping.target.duration.isNumeric,
              mapping.target.start.isNumeric, mapping.target.start == end,
              mapping.target.duration > .zero,
              mapping.source.duration == mapping.target.duration else {
            throw ProbeFailure("unsupported audio track edits (gaps or time scaling)")
        }
        end = CMTimeRangeGetEnd(mapping.target)
    }
    guard end == CMTimeRangeGetEnd(range) else {
        throw ProbeFailure("audio track edits do not cover its duration")
    }
    return range.duration
}

private func checkDecodeSource(_ source: URL, attributes: [FileAttributeKey: Any]) throws {
    let current = try FileManager.default.attributesOfItem(atPath: source.path)
    guard current[.type] as? FileAttributeType == .typeRegular,
          current[.size] as? NSNumber == attributes[.size] as? NSNumber,
          current[.systemFileNumber] as? NSNumber == attributes[.systemFileNumber] as? NSNumber,
          current[.systemNumber] as? NSNumber == attributes[.systemNumber] as? NSNumber,
          current[.modificationDate] as? Date == attributes[.modificationDate] as? Date else {
        throw ProbeFailure("input changed during decode")
    }
}

// Dependency seam for deterministic short-read/cleanup/cancellation tests; the
// command always supplies a fresh AVAssetReader, never a test flag or env hook.
func publishDecodedPCM(destination: URL, expectedDuration: CMTime,
                       decodeAttempt: (FileHandle) throws -> Int) throws -> Int {
    guard expectedDuration.isNumeric, expectedDuration.epoch == 0, expectedDuration > .zero,
          expectedDuration <= CMTime(value: 120, timescale: 1) else {
        throw ProbeFailure("unsupported audio track duration")
    }
    let files = FileManager.default
    // Fixed 1 ms (16 output frames), matching the existing AAC boundary contract.
    // This permits up to 1 ms loss, not proof of bit-exact resampling. It must
    // not scale with input duration or expand to hide a missing AAC tail buffer.
    let tolerance = CMTime(value: 1, timescale: 1000)
    // A source frame can end between 16-kHz samples. Permit only that final
    // quantization step (<1 output frame), never a fixed upper time allowance.
    let maximumFrames = CMTimeConvertScale(expectedDuration, timescale: 16000, method: .roundAwayFromZero).value
    for attempt in 1...3 {
        try Task.checkCancellation()
        guard !files.fileExists(atPath: destination.path) else { throw ProbeFailure("output already exists") }
        let partial = destination.deletingLastPathComponent().appendingPathComponent(".decode-\(UUID().uuidString).pcm")
        guard files.createFile(atPath: partial.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw ProbeFailure("could not create private output")
        }
        defer { try? files.removeItem(at: partial) }
        let handle = try FileHandle(forWritingTo: partial)
        defer { try? handle.close() }
        let total = try decodeAttempt(handle)
        try Task.checkCancellation()
        guard total > 0, total % 2 == 0, total <= 120 * 16000 * 2 else {
            throw ProbeFailure("invalid decoded PCM size")
        }
        let actual = CMTime(value: Int64(total / 2), timescale: 16000)
        guard Int64(total / 2) <= maximumFrames else {
            throw ProbeFailure("decoded audio exceeds exact frame reference duration")
        }
        if CMTimeAdd(actual, tolerance) < expectedDuration {
            // Standalone probe diagnostics: fixed fields only, never media paths.
            FileHandle.standardError.write(Data(("decode duration deficit: attempt \(attempt)/3, frames \(total / 2)\n").utf8))
            continue
        }
        try handle.close()
        try Task.checkCancellation()
        try files.moveItem(at: partial, to: destination)
        return total
    }
    throw ProbeFailure("decoded audio duration deficit after 3 attempts; no output published")
}

private func decodePCM(asset: AVAsset, audioTrack: AVAssetTrack, handle: FileHandle) throws -> Int {
    let reader = try AVAssetReader(asset: asset)
    defer { reader.cancelReading() }
    let track = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: 16000,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
    ])
    guard reader.canAdd(track) else { throw ProbeFailure("decoder does not support input") }
    reader.add(track)
    guard reader.startReading() else { throw ProbeFailure("decoder start failed") }
    var total = 0
    while let sample = track.copyNextSampleBuffer() {
        try Task.checkCancellation()
        guard let block = CMSampleBufferGetDataBuffer(sample) else { throw ProbeFailure("missing PCM data") }
        let count = CMBlockBufferGetDataLength(block)
        if count == 0 { continue }
        guard count <= 1_048_576, total + count <= 120 * 16000 * 2 else {
            throw ProbeFailure("decoded audio exceeded bounded PCM size")
        }
        var data = Data(count: count)
        let status = data.withUnsafeMutableBytes { buffer in
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: count, destination: buffer.baseAddress!)
        }
        guard status == noErr else { throw ProbeFailure("PCM copy failed") }
        try handle.write(contentsOf: data)
        total += count
    }
    guard reader.status == .completed, total > 0, total % 2 == 0 else { throw ProbeFailure("incomplete decode") }
    return total
}
