// Development feasibility probe, not a shipped Desktop service or agent tool.
import AVFoundation
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Speech

struct ProbeFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

func emit(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .prettyPrinted])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

@main
struct ListenerProbe {
    static func main() async {
        umask(0o077)
        do {
            let args = Array(CommandLine.arguments.dropFirst())
            switch args.first {
            case "inspect":
                guard args.count == 1 else { throw ProbeFailure("inspect takes no arguments") }
                try inspect()
            case "decode":
                guard args.count == 3 else { throw ProbeFailure("decode INPUT OUTPUT.pcm") }
                try await decodeAudio(input: args[1], output: args[2])
            case "capture":
                guard args.count == 4, args[1] == "--acknowledge-general-system-audio",
                      let seconds = Int(args[2]), (1...120).contains(seconds) else {
                    throw ProbeFailure("capture --acknowledge-general-system-audio SECONDS OUTPUT.m4a (1...120 seconds)")
                }
                try await captureAudio(seconds: seconds, output: args[3])
            case "microphone":
                guard args.count == 4, args[1] == "--acknowledge-microphone",
                      let seconds = Int(args[2]), (1...120).contains(seconds) else {
                    throw ProbeFailure("microphone --acknowledge-microphone SECONDS OUTPUT.caf (1...120 seconds)")
                }
                try await captureMicrophone(seconds: seconds, output: args[3])
            default:
                throw ProbeFailure("Usage: listener-probe inspect | decode INPUT OUTPUT.pcm | capture --acknowledge-general-system-audio SECONDS OUTPUT.m4a | microphone --acknowledge-microphone SECONDS OUTPUT.caf")
            }
        } catch {
            // Avoid printing media paths, transcripts, or arbitrary framework error payloads.
            let message = (error as? ProbeFailure)?.description ?? "native probe failed (\(type(of: error)))"
            FileHandle.standardError.write(Data((message + "\n").utf8))
            exit(1)
        }
    }

    static func inspect() throws {
        let locales = SFSpeechRecognizer.supportedLocales()
        let rows: [[String: Any]] = ["ru-RU", "en-US"].map { identifier in
            let locale = Locale(identifier: identifier)
            let recognizer = SFSpeechRecognizer(locale: locale)
            return [
                "locale": identifier,
                "supported": locales.contains(locale),
                "available": recognizer?.isAvailable ?? false,
                "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
            ]
        }
        try emit([
            "os": ProcessInfo.processInfo.operatingSystemVersionString,
            "screenCapturePreauthorized": CGPreflightScreenCaptureAccess(),
            "speechAuthorization": SFSpeechRecognizer.authorizationStatus().rawValue,
            "microphoneAuthorization": AVCaptureDevice.authorizationStatus(for: .audio).rawValue,
            "speech": rows,
            "note": "Capability snapshot only; no recording, authorization request or recognition performed.",
        ])
    }
}
