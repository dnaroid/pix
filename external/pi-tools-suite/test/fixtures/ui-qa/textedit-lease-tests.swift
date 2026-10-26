import Foundation

@main
enum LeaseTests {
    static func main() throws {
        var checks = 0
        func check(_ condition: Bool) { precondition(condition); checks += 1 }
        func refused(_ operation: () throws -> Void) {
            do { try operation(); preconditionFailure("unsafe transition accepted") } catch { checks += 1 }
        }
        // A matching PID is deliberately irrelevant to Foundation instance identity.
        final class FakeApp: NSObject { let pid = 42 }
        let app = FakeApp(), recycledPID = FakeApp()
        check(app.pid == recycledPID.pid)
        check(TextEditAdmission.instance(app, live: [app], terminated: false, metadataMatches: true))
        for apps in [[], [recycledPID], [app, recycledPID]] {
            check(!TextEditAdmission.instance(app, live: apps, terminated: false, metadataMatches: true))
        }
        check(!TextEditAdmission.instance(app, live: [app], terminated: true, metadataMatches: true))
        check(!TextEditAdmission.instance(app, live: [app], terminated: false, metadataMatches: false))
        for value in [nil, "foreign document", "g?"] as [String?] {
            check(!TextEditAdmission.value(value, confirmed: "g", inFlight: "gh"))
        }
        check(TextEditAdmission.value("g", confirmed: "g", inFlight: "gh"))
        check(TextEditAdmission.value("gh", confirmed: "g", inFlight: "gh"))
        var healthy = TextEditLease()
        refused { try healthy.prepare() }
        try healthy.launch()
        check(healthy.complete(hasHandle: true, admitted: true))
        check(!healthy.complete(hasHandle: true, admitted: true))
        refused { try healthy.launch() }
        try healthy.prepare(); try healthy.smoke(); try healthy.smoked()
        refused { try healthy.smoke() }
        check(healthy.release() == "manualRequired")
        refused { try healthy.requireLive() }
        // EOF, signal, timeout, observer taint and protocol failure share this
        // irreversible revocation, including during a partially sent pair.
        for phase in 0...4 {
            var lease = TextEditLease()
            try lease.launch()
            if phase > 0 { _ = lease.complete(hasHandle: true, admitted: true) }
            if phase > 1 { try lease.prepare() }
            if phase > 2 { try lease.smoke() }
            if phase > 3 { try lease.smoked() }
            lease.abandon()
            if phase == 0 { check(lease.complete(hasHandle: true, admitted: true)) }
            refused { try lease.requireLive() }
            refused { try lease.prepare() }
            refused { try lease.smoke() }
            check(lease.release() == "manualRequired")
        }
        for handle in [false, true] {
            var lease = TextEditLease()
            try lease.launch()
            _ = lease.complete(hasHandle: handle, admitted: false)
            refused { try lease.requireLive() }
            check(lease.release() == (handle ? "manualRequired" : "unknown"))
        }
        var absent = TextEditLease()
        check(absent.release() == "notNeeded")
        var missingCallback = TextEditLease()
        try missingCallback.launch(); missingCallback.abandon()
        check(missingCallback.release(observedExit: true) == "unknown")
        check(missingCallback.complete(hasHandle: true, admitted: true))
        refused { try missingCallback.prepare() }
        var exited = TextEditLease()
        try exited.launch(); _ = exited.complete(hasHandle: true, admitted: true)
        check(exited.release(observedExit: true) == "confirmed")
        print("\(checks) policy checks passed; no AppKit, launch, input or termination API linked")
    }
}
