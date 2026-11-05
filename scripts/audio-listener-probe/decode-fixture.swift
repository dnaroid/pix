// Synthetic media and injected decoder outcomes only; no device or STT access.
import AVFoundation
import AudioToolbox
import Foundation

struct ProbeFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
func emit(_ value: [String: Any]) throws {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value))
}
func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw ProbeFailure(message) }
}

func frameCase(_ mode: String) throws {
    var frames: Int64 = 48000
    var rate: Int32 = 48000
    var priming: Int64 = 2112
    var timeline = CMTime(value: 45888, timescale: 48000)
    var packets: UInt64 = 49
    var table = AudioFilePacketTableInfo(mNumberValidFrames: frames, mPrimingFrames: 2112, mRemainderFrames: 64)
    switch mode {
    case "frames-aac-priming", "frames-table-valid": break
    case "frames-pcm": priming = 0; timeline = CMTime(value: 1, timescale: 1)
    case "frames-120": frames = 5760000; timeline = CMTime(value: frames - priming, timescale: rate)
    case "frames-121": frames = 5808000
    case "frames-zero": frames = 0
    case "frames-bad-rate": rate = 0
    case "frames-negative-priming": priming = -1
    case "frames-trimmed": timeline = CMTime(value: 1, timescale: 2)
    case "frames-too-short": frames -= 2200
    case "frames-invalid-time": timeline = .invalid
    case "frames-table-overflow": packets = UInt64.max
    case "frames-table-mismatch": packets = 48
    case "frames-table-wrong-valid": table.mNumberValidFrames -= 1
    case "frames-table-negative": table.mRemainderFrames = -1
    default: throw ProbeFailure("unknown frame case")
    }
    let valid = ["frames-aac-priming", "frames-pcm", "frames-120", "frames-table-valid"].contains(mode)
    var rejected = false
    do {
        if mode.hasPrefix("frames-table-") {
            try validateAACPacketTable(frames: frames, packets: packets, table: table)
        } else {
            _ = try validateDecodeFrameReference(frames: frames, rate: rate, priming: priming, timelineDuration: timeline)
        }
    } catch { rejected = true }
    try require(rejected != valid, "wrong frame reference verdict")
}

func referenceCase(_ mode: String) throws {
    let one = CMTime(value: 1, timescale: 1)
    let half = CMTime(value: 1, timescale: 2)
    // AAC priming is excluded by the source edit; presentation can start late.
    let origin = CMTime(value: 10, timescale: 1)
    let source = CMTimeRange(start: CMTime(value: 2112, timescale: 48000), duration: one)
    var range = CMTimeRange(start: origin, duration: one)
    func segment(_ source: CMTimeRange, _ target: CMTimeRange) -> AVAssetTrackSegment {
        AVCompositionTrackSegment(url: URL(fileURLWithPath: "/unused-synthetic-source"),
            trackID: 1, sourceTimeRange: source, targetTimeRange: target)
    }
    var segments = [segment(source, range)]
    switch mode {
    case "reference-offset-trim": break
    case "reference-contiguous":
        segments = [segment(CMTimeRange(start: .zero, duration: half), CMTimeRange(start: origin, duration: half)),
                    segment(CMTimeRange(start: half, duration: half), CMTimeRange(start: CMTimeAdd(origin, half), duration: half))]
    case "reference-gap":
        segments = [segment(source, CMTimeRange(start: CMTimeAdd(origin, half), duration: one))]
    case "reference-scaled": segments = [segment(CMTimeRange(start: .zero, duration: half), range)]
    case "reference-empty": segments = [AVCompositionTrackSegment(timeRange: range)]
    case "reference-missing": segments = []
    case "reference-incomplete": segments = [segment(CMTimeRange(start: .zero, duration: half), CMTimeRange(start: origin, duration: half))]
    case "reference-invalid": range = .invalid
    case "reference-indefinite": range = CMTimeRange(start: .zero, duration: .indefinite)
    case "reference-too-long": range = CMTimeRange(start: .zero, duration: CMTime(value: 121, timescale: 1))
    case "reference-zero": range = CMTimeRange(start: .zero, duration: .zero)
    default: throw ProbeFailure("unknown reference case")
    }
    let valid = mode == "reference-offset-trim"
    do {
        let duration = try decodeTimelineDuration(range: range, segments: segments)
        try require(valid && duration == one, "wrong reference accepted")
    } catch {
        if valid { throw error }
        // A successful call above is not a rejection.
        try require((error as? ProbeFailure)?.description != "wrong reference accepted", "unsupported reference accepted")
    }
}

func transactionCase(_ mode: String, directory: URL) async throws {
    let files = FileManager.default
    let destination = directory.appendingPathComponent("output.pcm")
    let seconds = mode == "exhaust-120" ? 120 : 1
    let expectedBytes = seconds * 32000
    let expectedDuration = mode.hasPrefix("rounding-") ? CMTime(value: 48001, timescale: 48000) : CMTime(value: Int64(seconds), timescale: 1)
    var attempts = 0
    var partialNames = Set<String>()
    if mode == "existing" { try Data([99]).write(to: destination) }
    if mode == "cancel-before" { withUnsafeCurrentTask { $0?.cancel() } }
    let succeeds = ["complete", "retry-second", "retry-third", "minor-six", "tolerance-edge", "rounding-up", "rounding-minimum"].contains(mode)
    do {
        let total = try publishDecodedPCM(destination: destination, expectedDuration: expectedDuration) { handle in
            attempts += 1
            let names = try files.contentsOfDirectory(atPath: directory.path).filter { $0.hasPrefix(".decode-") }
            try require(names.count == 1, "previous attempt not cleaned")
            try require(partialNames.insert(names[0]).inserted, "attempt reused a partial")
            let attrs = try files.attributesOfItem(atPath: directory.appendingPathComponent(names[0]).path)
            try require((attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600, "partial not private")
            var bytes = expectedBytes
            switch mode {
            case "retry-second": if attempts == 1 { bytes -= 1024 }
            case "retry-third": if attempts < 3 { bytes -= 1024 }
            case "exhaust", "exhaust-120": bytes -= 1024
            case "minor-six": bytes -= 12
            case "tolerance-edge": bytes -= 32
            case "outside-tolerance": bytes -= 34
            case "overlong": bytes += 34
            case "overlong-one-frame": bytes += 2
            case "rounding-up": bytes += 2
            case "rounding-excess": bytes += 4
            case "rounding-minimum": bytes -= 30
            case "rounding-deficit": bytes -= 32
            case "empty": bytes = 0
            case "odd": bytes -= 1
            default: break
            }
            try handle.write(contentsOf: Data(repeating: UInt8(attempts), count: bytes))
            if mode == "io-error" { throw ProbeFailure("injected I/O failure") }
            if mode == "cancel-after" { withUnsafeCurrentTask { $0?.cancel() } }
            if mode == "destination-race" { try Data([99]).write(to: destination) }
            return bytes
        }
        try require(succeeds, "failure published")
        let content = try Data(contentsOf: destination)
        try require(content == Data(repeating: UInt8(attempts), count: total), "padding, concatenation or stale bytes")
    } catch {
        if succeeds { throw error }
        try require((error as? ProbeFailure)?.description != "failure published", "failure published")
        if mode.hasPrefix("cancel-") { try require(error is CancellationError, "wrong cancellation error") }
        if ["exhaust", "exhaust-120", "outside-tolerance", "rounding-deficit"].contains(mode) {
            try require((error as? ProbeFailure)?.description.contains("after 3 attempts") == true, "wrong exhaustion error")
        }
    }
    let expectedAttempts: Int
    switch mode {
    case "cancel-before", "existing": expectedAttempts = 0
    case "exhaust", "exhaust-120", "outside-tolerance", "retry-third", "rounding-deficit": expectedAttempts = 3
    case "retry-second": expectedAttempts = 2
    default: expectedAttempts = 1
    }
    try require(attempts == expectedAttempts, "wrong retry count: \(attempts)")
    let names = try files.contentsOfDirectory(atPath: directory.path)
    try require(!names.contains { $0.hasPrefix(".decode-") }, "partial leaked")
    if ["existing", "destination-race"].contains(mode) {
        let data = try Data(contentsOf: destination)
        try require(data == Data([99]), "existing destination changed")
    } else {
        try require(files.fileExists(atPath: destination.path) == succeeds, "wrong publication outcome")
    }
}

@main struct Driver {
    static func main() async {
        do {
            let mode = CommandLine.arguments[1]
            if mode.hasPrefix("frames-") {
                try frameCase(mode)
            } else if mode.hasPrefix("reference-") {
                try referenceCase(mode)
            } else if mode.hasPrefix("video-") {
                try await videoReferenceCase(directory: URL(fileURLWithPath: CommandLine.arguments[2]),
                    inconsistentMetadata: mode == "video-inconsistent")
            } else if mode.hasPrefix("media-fractional-") {
                try await fractionalReferenceCase(mode, directory: URL(fileURLWithPath: CommandLine.arguments[2]))
            } else {
                try await transactionCase(mode, directory: URL(fileURLWithPath: CommandLine.arguments[2]))
            }
            try emit(["verified": true])
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(1)
        }
    }
}
