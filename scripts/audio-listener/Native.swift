import Foundation

struct ProbeFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

func emit(_ value: [String: Any]) throws {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value))
    FileHandle.standardOutput.write(Data([10]))
}

// Local helper for the trusted extension. Consent is supplied over private stdin
// only after its UI confirmation, never through model-controlled tool arguments.
// This is not a sandbox against arbitrary local code with microphone permission.
@main
struct LocalListener {
    static func main() async {
        umask(0o077)
        do {
            let args = Array(CommandLine.arguments.dropFirst())
            switch args.first {
            case "decode":
                guard args.count == 3 else { throw ProbeFailure("decode INPUT OUTPUT") }
                try await decodeAudio(input: args[1], output: args[2])
            case "microphone":
                guard args.count == 3, let seconds = Int(args[1]), (1...120).contains(seconds) else {
                    throw ProbeFailure("microphone SECONDS OUTPUT (1...120 seconds)")
                }
                try await captureMicrophone(seconds: seconds, output: args[2], confirmation: {
                    guard readLine() == "PIX_LISTENER_MICROPHONE_CONFIRMED" else {
                        throw ProbeFailure("microphone capture not confirmed")
                    }
                })
            default:
                throw ProbeFailure("Only decode and microphone are supported")
            }
        } catch {
            let message = (error as? ProbeFailure)?.description ?? "native listener failed"
            FileHandle.standardError.write(Data((message + "\n").utf8))
            exit(1)
        }
    }
}
