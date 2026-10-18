package dev.pix.uiqa;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/** Pure JVM regression for initial-root readiness; never loads Android runtime. */
public final class InitialRootCheck {
    private static void check(boolean condition) {
        if (!condition) throw new AssertionError("initial root readiness regression");
    }
    public static void main(String[] args) throws Exception {
        Object expected = new Object();
        AtomicInteger reads = new AtomicInteger();
        AtomicLong now = new AtomicLong();
        Object immediate = HierarchyDump.InitialRoot.get(() -> { reads.incrementAndGet(); return expected; }, now::get,
            millis -> { throw new AssertionError("available root must not wait"); });
        check(immediate == expected && reads.get() == 1);

        reads.set(0);
        Object delayed = HierarchyDump.InitialRoot.get(() -> reads.incrementAndGet() < 4 ? null : expected, now::get, now::addAndGet);
        check(delayed == expected && reads.get() == 4 && now.get() == 150);

        reads.set(0); now.set(0);
        Object missing = HierarchyDump.InitialRoot.get(() -> { reads.incrementAndGet(); return null; }, now::get, now::addAndGet);
        check(missing == null && reads.get() == 31 && now.get() == 1500);

        reads.set(0);
        Object frozenClock = HierarchyDump.InitialRoot.get(() -> { reads.incrementAndGet(); return null; }, () -> 0, millis -> { });
        check(frozenClock == null && reads.get() == 31);

        reads.set(0);
        try {
            HierarchyDump.InitialRoot.get(() -> { reads.incrementAndGet(); throw new IllegalStateException(); }, now::get, now::addAndGet);
            throw new AssertionError("reader failures must propagate, not retry");
        } catch (IllegalStateException expectedFailure) { check(reads.get() == 1); }
        System.out.println("INITIAL_ROOT_CHECKS_PASSED=5");
    }
}
