import AVFoundation
import AudioToolbox
import Foundation

// A reference independent of the failing AVAssetReader/resampler: PCM file
// frames, or AAC-LC packet-table valid frames with priming/padding accounted for.
// No estimated compressed duration or container/video duration fallback.
func decodeFrameReference(source: URL, timelineDuration: CMTime) throws -> CMTime {
    let audio: AVAudioFile
    do { audio = try AVAudioFile(forReading: source) }
    catch { throw ProbeFailure("exact audio frame reference unavailable") }
    let format = audio.fileFormat.streamDescription.pointee
    let rate = format.mSampleRate
    guard rate.isFinite, (8000...192000).contains(rate), rate.rounded() == rate,
          audio.processingFormat.sampleRate == rate, (1...8).contains(format.mChannelsPerFrame),
          audio.length > 0, audio.length <= Int64(rate) * 120 else {
        throw ProbeFailure("unsupported audio frame reference format or duration")
    }
    var file: AudioFileID?
    guard AudioFileOpenURL(source as CFURL, .readPermission, 0, &file) == noErr, let file else {
        throw ProbeFailure("audio packet metadata unavailable")
    }
    defer { AudioFileClose(file) }
    var packets: UInt64 = 0
    var size = UInt32(MemoryLayout<UInt64>.size)
    guard AudioFileGetProperty(file, kAudioFilePropertyAudioDataPacketCount, &size, &packets) == noErr else {
        throw ProbeFailure("audio packet count unavailable")
    }
    var priming: Int64 = 0
    switch format.mFormatID {
    case kAudioFormatLinearPCM:
        guard format.mFramesPerPacket == 1, packets == UInt64(audio.length) else {
            throw ProbeFailure("inconsistent PCM frame reference")
        }
    case kAudioFormatMPEG4AAC:
        var table = AudioFilePacketTableInfo()
        size = UInt32(MemoryLayout<AudioFilePacketTableInfo>.size)
        guard format.mFramesPerPacket == 1024,
              AudioFileGetProperty(file, kAudioFilePropertyPacketTableInfo, &size, &table) == noErr,
              table.mNumberValidFrames == audio.length,
              table.mPrimingFrames >= 0, table.mRemainderFrames >= 0 else {
            throw ProbeFailure("exact AAC-LC packet table unavailable")
        }
        try validateAACPacketTable(frames: audio.length, packets: packets, table: table)
        priming = Int64(table.mPrimingFrames)
    default:
        throw ProbeFailure("exact frame reference supports only LPCM or table-backed AAC-LC")
    }
    return try validateDecodeFrameReference(frames: audio.length, rate: Int32(rate),
        priming: priming, timelineDuration: timelineDuration)
}

func validateAACPacketTable(frames: Int64, packets: UInt64, table: AudioFilePacketTableInfo) throws {
    guard frames > 0, frames <= 192000 * 120, table.mNumberValidFrames == frames,
          table.mPrimingFrames >= 0, table.mRemainderFrames >= 0 else {
        throw ProbeFailure("invalid AAC-LC packet table")
    }
    let (packetFrames, overflow) = packets.multipliedReportingOverflow(by: 1024)
    let describedFrames = UInt64(frames) + UInt64(table.mPrimingFrames) + UInt64(table.mRemainderFrames)
    guard !overflow, packetFrames == describedFrames else {
        throw ProbeFailure("inconsistent AAC-LC packet table")
    }
}

func validateDecodeFrameReference(frames: Int64, rate: Int32, priming: Int64,
                                  timelineDuration: CMTime) throws -> CMTime {
    guard (8000...192000).contains(rate), frames > 0, frames <= Int64(rate) * 120,
          priming >= 0, priming <= Int64(Int32.max), timelineDuration.isNumeric,
          timelineDuration > .zero, timelineDuration <= CMTime(value: 120, timescale: 1) else {
        throw ProbeFailure("invalid audio frame reference")
    }
    let duration = CMTime(value: frames, timescale: rate)
    let tolerance = CMTime(value: 1, timescale: 1000)
    // AVAssetWriter AAC can report a timeline shorter by its priming interval.
    // Larger discrepancies/edited media are unsupported, not a reason to widen
    // the PCM-output tolerance. Coarse metadata may conservatively fail here.
    guard CMTimeAdd(duration, tolerance) >= timelineDuration,
          duration <= CMTimeAdd(CMTimeAdd(timelineDuration, CMTime(value: priming, timescale: rate)), tolerance) else {
        throw ProbeFailure("audio timeline disagrees with exact frame reference")
    }
    return duration
}
