package dev.pix.uiqa;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Point;
import android.graphics.Rect;
import android.os.HandlerThread;
import android.os.Looper;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.lang.reflect.InvocationTargetException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/** Shell-UID, read-only accessibility snapshot. No idle wait or input APIs. */
public final class HierarchyDump {
    private static final int MAX_OUTPUT = 2 * 1024 * 1024;
    /** Connection readiness is not UI idleness. Retry only a missing initial
     * root; the first available root still passes all package/window guards. */
    static final class InitialRoot {
        interface Sleep { void pause(long millis) throws InterruptedException; }
        static <T> T get(Supplier<T> read, LongSupplier clock, Sleep sleep) throws InterruptedException {
            long deadline = clock.getAsLong() + 1_500;
            for (int attempt = 0; attempt < 31; attempt++) {
                T root = read.get();
                if (root != null) return root;
                long remaining = deadline - clock.getAsLong();
                if (remaining <= 0 || attempt == 30) break;
                sleep.pause(Math.min(50, remaining));
            }
            return null;
        }
    }
    private static final class Failure extends Exception {
        final String code;
        Failure(String code) { this.code = code; }
    }
    private static final class Frame {
        final AccessibilityNodeInfo node;
        final int depth;
        final String path;
        Frame(AccessibilityNodeInfo node, int depth, String path) { this.node = node; this.depth = depth; this.path = path; }
    }

    public static void main(String[] args) {
        // Closing a host ADB socket need not kill a remote Binder call. Process
        // death unregisters this automation client even if finally cannot run.
        Thread watchdog = new Thread(() -> {
            try { Thread.sleep(8_000); } catch (InterruptedException ignored) { return; }
            Runtime.getRuntime().halt(124);
        }, "pi-ui-qa-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();
        UiAutomation automation = null;
        HandlerThread thread = new HandlerThread("pi-ui-qa-accessibility");
        int status = 1;
        try {
            if (args.length != 1 || !args[0].matches("[A-Za-z]\\w*(?:\\.[A-Za-z]\\w*)+")) throw new Failure("INVALID_TARGET");
            thread.start();
            Class<?> connectionType = Class.forName("android.app.IUiAutomationConnection");
            Object connection = Class.forName("android.app.UiAutomationConnection").getConstructor().newInstance();
            automation = (UiAutomation) UiAutomation.class.getConstructor(Looper.class, connectionType).newInstance(thread.getLooper(), connection);
            UiAutomation.class.getMethod("connect", int.class).invoke(automation, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
            AccessibilityServiceInfo info = automation.getServiceInfo();
            if (info == null) throw new Failure("SERVICE_UNAVAILABLE");
            info.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
                | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
                | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
            automation.setServiceInfo(info);
            Display display = display();
            int rotation = display.getRotation();
            Point size = new Point();
            display.getRealSize(size);
            if (rotation < 0 || rotation > 3 || size.x <= 0 || size.y <= 0 || size.x > 16384 || size.y > 16384) throw new Failure("DISPLAY_UNAVAILABLE");
            AccessibilityNodeInfo root = InitialRoot.get(automation::getRootInActiveWindow,
                () -> System.nanoTime() / 1_000_000, Thread::sleep);
            if (root == null) throw new Failure("ROOT_UNAVAILABLE");
            int windowId;
            try { windowId = verifyRoot(root, args[0]); }
            catch (Throwable error) { root.recycle(); throw error; }
            String xml = snapshot(root, rotation, size);
            AccessibilityNodeInfo current = automation.getRootInActiveWindow();
            if (current == null) throw new Failure("ROOT_CHANGED");
            try {
                if (verifyRoot(current, args[0]) != windowId || display().getRotation() != rotation) throw new Failure("ROOT_CHANGED");
            } finally { current.recycle(); }
            byte[] bytes = xml.getBytes(StandardCharsets.UTF_8);
            if (bytes.length > MAX_OUTPUT) throw new Failure("OUTPUT_LIMIT");
            System.out.write(bytes);
            System.out.flush();
            status = 0;
        } catch (Throwable error) {
            String code = error instanceof Failure ? ((Failure) error).code : "PLATFORM_FAILURE";
            Throwable cause = error instanceof InvocationTargetException ? error.getCause() : error;
            if (cause instanceof IllegalStateException && String.valueOf(cause.getMessage()).contains("already registered")) code = "UIAUTOMATION_BUSY";
            System.out.print("PIQA-ERR:" + code);
            System.out.flush();
        } finally {
            if (automation != null) {
                try { UiAutomation.class.getMethod("disconnect").invoke(automation); } catch (Throwable ignored) { }
            }
            thread.quitSafely();
        }
        System.exit(status);
    }

    private static Display display() throws Exception {
        Class<?> type = Class.forName("android.hardware.display.DisplayManagerGlobal");
        Object global = type.getMethod("getInstance").invoke(null);
        Display display = (Display) type.getMethod("getRealDisplay", int.class).invoke(global, 0);
        if (display == null) throw new Failure("DISPLAY_UNAVAILABLE");
        return display;
    }

    private static int verifyRoot(AccessibilityNodeInfo root, String expectedPackage) throws Failure {
        if (!expectedPackage.contentEquals(root.getPackageName() == null ? "" : root.getPackageName())) throw new Failure("FOREGROUND_CHANGED");
        AccessibilityWindowInfo window = root.getWindow();
        if (window == null) throw new Failure("WINDOW_UNAVAILABLE");
        try { if (window.getDisplayId() != 0) throw new Failure("UNSUPPORTED_DISPLAY"); }
        finally { window.recycle(); }
        return root.getWindowId();
    }

    private static String snapshot(AccessibilityNodeInfo root, int rotation, Point size) throws Exception {
        StringBuilder xml = new StringBuilder("<hierarchy rotation=\"" + rotation + "\">");
        ArrayDeque<Frame> stack = new ArrayDeque<>();
        stack.push(new Frame(root, 1, "0"));
        int count = 0;
        try {
            while (!stack.isEmpty()) {
                Frame frame = stack.pop();
                AccessibilityNodeInfo node = frame.node;
                try {
                    if (++count > 5000 || frame.depth > 64) throw new Failure("NODE_LIMIT");
                    if (!node.isVisibleToUser()) continue;
                    Rect bounds = new Rect();
                    node.getBoundsInScreen(bounds);
                    if (bounds.intersect(0, 0, size.x, size.y)) {
                        xml.append("<node");
                        attr(xml, "node-path", frame.path);
                        attr(xml, "window-id", String.valueOf(node.getWindowId()));
                        attr(xml, "package", node.getPackageName());
                        attr(xml, "class", node.getClassName());
                        attr(xml, "resource-id", node.getViewIdResourceName());
                        attr(xml, "text", node.isPassword() ? "[REDACTED]" : node.getText());
                        attr(xml, "content-desc", node.isPassword() ? "[REDACTED]" : node.getContentDescription());
                        attr(xml, "password", String.valueOf(node.isPassword()));
                        attr(xml, "enabled", String.valueOf(node.isEnabled()));
                        attr(xml, "checked", String.valueOf(node.isChecked()));
                        attr(xml, "selected", String.valueOf(node.isSelected()));
                        attr(xml, "focused", String.valueOf(node.isFocused()));
                        attr(xml, "clickable", String.valueOf(node.isClickable()));
                        attr(xml, "bounds", "[" + bounds.left + "," + bounds.top + "][" + bounds.right + "," + bounds.bottom + "]");
                        xml.append("/>");
                    }
                    int children = node.getChildCount();
                    if (children < 0 || children > 5000 || stack.size() + children > 5000) throw new Failure("NODE_LIMIT");
                    for (int i = children - 1; i >= 0; i--) {
                        AccessibilityNodeInfo child = node.getChild(i);
                        if (child != null) stack.push(new Frame(child, frame.depth + 1, frame.path + "." + i));
                    }
                } finally { node.recycle(); }
            }
        } finally { while (!stack.isEmpty()) stack.pop().node.recycle(); }
        return xml.append("</hierarchy>").toString();
    }

    private static void attr(StringBuilder xml, String name, CharSequence raw) throws Failure {
        String value = raw == null ? "" : raw.toString();
        if (value.length() > 32768) throw new Failure("ATTRIBUTE_LIMIT");
        xml.append(' ').append(name).append("=\"");
        for (int offset = 0; offset < value.length();) {
            int c = value.codePointAt(offset);
            offset += Character.charCount(c);
            switch (c) {
                case '&': xml.append("&amp;"); break;
                case '<': xml.append("&lt;"); break;
                case '>': xml.append("&gt;"); break;
                case '"': xml.append("&quot;"); break;
                case 9: case 10: case 13: xml.append("&#").append(c).append(';'); break;
                default: xml.appendCodePoint(c < 32 || c >= 0xd800 && c <= 0xdfff || c == 0xfffe || c == 0xffff ? 0xfffd : c);
            }
        }
        xml.append('"');
        if (xml.length() > MAX_OUTPUT) throw new Failure("OUTPUT_LIMIT");
    }
}
