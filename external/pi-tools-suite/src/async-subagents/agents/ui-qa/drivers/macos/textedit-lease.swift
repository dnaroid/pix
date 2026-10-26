import Foundation

// Pure lifecycle policy, also compiled by the non-UI regression harness.
// There deliberately is no application termination operation in this policy.
struct TextEditLease {
    enum Phase: String { case idle, requesting, owned, ready, smoking, smoked, abandoned, released }
    private(set) var phase: Phase = .idle
    private(set) var requested = false
    private(set) var completionSeen = false
    private(set) var hasHandle = false
    private(set) var cancelled = false

    mutating func launch() throws {
        guard phase == .idle else { throw LeaseError("launch is single-use") }
        requested = true
        phase = .requesting
    }

    // A late callback may add diagnostics but can never restore input permission.
    mutating func complete(hasHandle: Bool, admitted: Bool) -> Bool {
        guard !completionSeen, requested else { return false }
        completionSeen = true
        self.hasHandle = hasHandle
        if phase == .requesting && admitted && hasHandle && !cancelled { phase = .owned }
        else if phase != .released { phase = .abandoned }
        return true
    }

    mutating func prepare() throws {
        guard phase == .owned, !cancelled else { throw LeaseError("lease is not owned") }
        phase = .ready
    }

    mutating func smoke() throws {
        guard phase == .ready, !cancelled else { throw LeaseError("smoke requires a ready, unused lease") }
        phase = .smoking
    }

    mutating func smoked() throws {
        guard phase == .smoking, !cancelled else { throw LeaseError("smoke was cancelled") }
        phase = .smoked
    }

    mutating func abandon() {
        cancelled = true
        if phase != .released { phase = .abandoned }
    }

    func requireLive() throws {
        guard !cancelled, [.owned, .ready, .smoking, .smoked].contains(phase) else {
            throw LeaseError("lease no longer permits access")
        }
    }

    mutating func release(observedExit: Bool = false) -> String {
        cancelled = true
        phase = .released
        if observedExit && hasHandle { return "confirmed" }
        if hasHandle { return "manualRequired" }
        return requested ? "unknown" : "notNeeded"
    }
}

struct LeaseError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

enum TextEditAdmission {
    // NSObject.isEqual is deliberately the identity operation, not PID equality.
    static func instance(_ retained: NSObject, live: [NSObject], terminated: Bool, metadataMatches: Bool) -> Bool {
        !terminated && metadataMatches && live.count == 1 && live[0].isEqual(retained)
    }

    static func value(_ value: String?, confirmed: String, inFlight: String) -> Bool {
        guard let value else { return false }
        return value == confirmed || value == inFlight
    }
}
