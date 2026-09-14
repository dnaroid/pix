#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import sys
import time


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def parse_options(values: list[str]) -> dict[str, object]:
    result: dict[str, object] = {}
    index = 0
    while index < len(values):
        key = values[index]
        if not key.startswith("--"):
            fail(f"unexpected argument: {key}")
        name = key[2:]
        if name in {"all", "print-pid"}:
            result[name] = True
            index += 1
            continue
        if index + 1 >= len(values):
            fail(f"missing value for {key}")
        if name in result:
            fail(f"duplicate option: {key}")
        result[name] = values[index + 1]
        index += 2
    return result


def require_option(options: dict[str, object], name: str) -> str:
    value = options.get(name)
    if not isinstance(value, str) or not value:
        fail(f"missing --{name}")
    return value


try:
    import pyatspi  # type: ignore
except Exception as error:
    if len(sys.argv) > 1 and sys.argv[1] == "doctor":
        fail(f"AT-SPI Python bindings are unavailable: {error}")
    raise


def process_id(accessible) -> int | None:
    for name in ("get_process_id", "getProcessId"):
        method = getattr(accessible, name, None)
        if callable(method):
            try:
                value = int(method())
                return value if value > 0 else None
            except Exception:
                pass
    return None


def role_name(accessible) -> str:
    try:
        return str(accessible.getRoleName() or "unknown")
    except Exception:
        return "unknown"


def normalize_role(value: str) -> str:
    return "".join(character.lower() for character in value if character.isalnum())


def children(accessible) -> list[object]:
    result: list[object] = []
    try:
        count = int(accessible.childCount)
        for index in range(max(0, count)):
            try:
                child = accessible.getChildAtIndex(index)
                if child is not None:
                    result.append(child)
            except Exception:
                continue
    except Exception:
        try:
            result.extend(list(accessible))
        except Exception:
            pass
    return result


def state_contains(accessible, state) -> bool:
    try:
        return bool(accessible.getState().contains(state))
    except Exception:
        return False


def accessible_attributes(accessible) -> dict[str, str]:
    attributes: dict[str, str] = {}
    try:
        if accessible.name:
            attributes["title"] = str(accessible.name)
    except Exception:
        pass
    try:
        if accessible.description:
            attributes["description"] = str(accessible.description)
    except Exception:
        pass
    try:
        for raw in accessible.getAttributes() or []:
            if ":" not in raw:
                continue
            key, value = raw.split(":", 1)
            if key in {"id", "automation-id", "accessible-id"} and value:
                attributes["identifier"] = value
                break
    except Exception:
        pass

    protected_state = getattr(pyatspi, "STATE_PROTECTED", None)
    if protected_state is not None and state_contains(accessible, protected_state):
        attributes["value"] = "<redacted>"
    else:
        try:
            text = accessible.queryText()
            value = text.getText(0, -1)
            if value:
                attributes["value"] = str(value).replace("\r", " ").replace("\n", " ")
        except Exception:
            try:
                value_iface = accessible.queryValue()
                numeric = float(value_iface.currentValue)
                attributes["value"] = str(int(numeric)) if numeric.is_integer() else str(numeric)
            except Exception:
                pass

    if "value" not in attributes and hasattr(pyatspi, "STATE_CHECKED"):
        try:
            states = accessible.getState()
            if states.contains(pyatspi.STATE_CHECKED):
                attributes["value"] = "1"
            elif normalize_role(role_name(accessible)) in {"checkbox", "checkmenuitem"}:
                attributes["value"] = "0"
        except Exception:
            pass

    attributes["enabled"] = str(state_contains(accessible, pyatspi.STATE_ENABLED)).lower()
    attributes["focused"] = str(state_contains(accessible, pyatspi.STATE_FOCUSED)).lower()
    attributes["selected"] = str(state_contains(accessible, pyatspi.STATE_SELECTED)).lower()
    return attributes


def frame(accessible) -> dict[str, int]:
    try:
        extents = accessible.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
        return {
            "x": int(extents.x),
            "y": int(extents.y),
            "width": int(extents.width),
            "height": int(extents.height),
        }
    except Exception:
        return {"x": 0, "y": 0, "width": 0, "height": 0}


def record(accessible, path_value: str) -> dict[str, object]:
    return {
        "path": path_value,
        "role": role_name(accessible),
        "attributes": accessible_attributes(accessible),
        "frame": frame(accessible),
    }


def walk(root, depth: int, limit: int) -> list[tuple[object, str]]:
    result: list[tuple[object, str]] = []

    def visit(accessible, path_value: str, level: int) -> None:
        if len(result) >= limit:
            return
        result.append((accessible, path_value))
        if level >= depth:
            return
        for index, child in enumerate(children(accessible)):
            visit(child, f"{path_value}/{index}", level + 1)
            if len(result) >= limit:
                return

    visit(root, "0", 0)
    return result


def application_windows(application) -> list[object]:
    direct = children(application)
    windows = []
    for item in direct:
        role = normalize_role(role_name(item))
        if role in {"frame", "dialog", "window", "application"}:
            windows.append(item)
    return windows or direct or [application]


def candidate_process_matches(pid: int | None, options: dict[str, object]) -> bool:
    if pid is None:
        return not any(key in options for key in ("pid", "pgid"))
    if "pid" in options and pid != int(require_option(options, "pid")):
        return False
    if "pgid" in options:
        try:
            if os.getpgid(pid) != int(require_option(options, "pgid")):
                return False
        except (ProcessLookupError, PermissionError, OSError):
            return False
    return True


def find_window(options: dict[str, object]):
    desktop = pyatspi.Registry.getDesktop(0)
    requested_app = str(options.get("app", "")).lower()
    requested_title = str(options.get("title", ""))
    matches: list[tuple[object, int | None]] = []
    for application in children(desktop):
        pid = process_id(application)
        if not candidate_process_matches(pid, options):
            continue
        try:
            app_name = str(application.name or "")
        except Exception:
            app_name = ""
        for window in application_windows(application):
            try:
                window_name = str(window.name or "")
            except Exception:
                window_name = ""
            if requested_title and requested_title.lower() not in window_name.lower():
                continue
            if requested_app and requested_app not in app_name.lower() and requested_app not in window_name.lower():
                continue
            matches.append((window, pid))
    if not matches:
        return None
    if len(matches) > 1 and not any(key in options for key in ("pid", "pgid", "title")):
        fail(f"ambiguous app selector ({len(matches)} windows); use --pid")
    return matches[0]


def wait_window(options: dict[str, object], timeout: float):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        candidate = find_window(options)
        if candidate is not None:
            return candidate
        time.sleep(0.1)
    fail("timed out waiting for application window")


def focus_window(window) -> None:
    try:
        if window.queryComponent().grabFocus():
            return
    except Exception:
        pass
    try:
        window.grabFocus()
        return
    except Exception:
        fail("AT-SPI could not focus the target window")


def element_by_path(window, path_value: str):
    parts = [part for part in path_value.split("/") if part]
    current = window
    start = 1 if parts and parts[0] == "0" else 0
    for raw in parts[start:]:
        try:
            index = int(raw)
        except ValueError:
            fail("invalid element path")
        available = children(current)
        if index < 0 or index >= len(available):
            fail("element path does not exist")
        current = available[index]
    return current


def find_element(window, options: dict[str, object]):
    if "path" in options:
        return element_by_path(window, require_option(options, "path"))
    match = require_option(options, "match").lower()
    requested_role = normalize_role(str(options.get("role", "")).replace("AX", ""))
    occurrence = int(str(options.get("occurrence", "1")))
    seen = 0
    for accessible, _ in walk(window, 20, 1000):
        attributes = accessible_attributes(accessible)
        haystack = " ".join(attributes.values()).lower()
        if match not in haystack:
            continue
        if requested_role and normalize_role(role_name(accessible)) != requested_role:
            continue
        seen += 1
        if seen == occurrence:
            return accessible
    fail("no accessibility element matches the supplied selector")


def format_record(accessible, path_value: str) -> str:
    value = record(accessible, path_value)
    parts = [path_value, str(value["role"])]
    for key, item in value["attributes"].items():
        safe = str(item).replace("\r", " ").replace("\n", " ").replace('"', '\\"')
        if safe:
            parts.append(f'{key}="{safe}"')
    rectangle = value["frame"]
    parts.append(f'frame={rectangle["x"]},{rectangle["y"]},{rectangle["width"]}x{rectangle["height"]}')
    return " ".join(parts)


def click_element(accessible) -> None:
    try:
        actions = accessible.queryAction()
        for index in range(actions.nActions):
            name = str(actions.getName(index) or "").lower()
            if name in {"click", "press", "activate", "open", "toggle"}:
                if actions.doAction(index):
                    return
        if actions.nActions > 0 and actions.doAction(0):
            return
    except Exception:
        pass
    rectangle = frame(accessible)
    if rectangle["width"] <= 0 or rectangle["height"] <= 0:
        fail("element has no AT-SPI action or visible frame")
    x = rectangle["x"] + rectangle["width"] // 2
    y = rectangle["y"] + rectangle["height"] // 2
    try:
        pyatspi.Registry.generateMouseEvent(x, y, "b1c")
    except Exception as error:
        fail(f"AT-SPI click fallback failed: {error}")


def set_value(accessible, value: str) -> None:
    try:
        accessible.queryEditableText().setTextContents(value)
        return
    except Exception:
        pass
    try:
        value_iface = accessible.queryValue()
        value_iface.currentValue = float(value)
        return
    except Exception:
        fail("element does not expose editable text or numeric AT-SPI value")


def xdotool() -> str | None:
    return shutil.which("xdotool")


def keyboard_backend_available() -> bool:
    tool = xdotool()
    if tool is None:
        return False
    try:
        result = subprocess.run(
            [tool, "getactivewindow"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=3,
        )
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def screenshot_backend() -> tuple[str, str] | None:
    executable = shutil.which("gnome-screenshot")
    if executable:
        return executable, "gnome-screenshot"
    executable = shutil.which("scrot")
    if executable:
        return executable, "scrot"
    return None


def capture_window(window, output: str) -> None:
    backend = screenshot_backend()
    if backend is None:
        fail("no supported Linux window screenshot producer is installed")
    directory = os.path.dirname(os.path.abspath(output))
    if not os.path.isdir(directory):
        fail("screenshot output directory does not exist")
    focus_window(window)
    time.sleep(0.12)
    executable, kind = backend
    if kind == "gnome-screenshot":
        command = [executable, "-w", "-f", output]
    else:
        command = [executable, "-u", output]
    result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
    if result.returncode != 0 or not os.path.isfile(output) or os.path.getsize(output) < 1:
        fail((result.stderr or result.stdout or "window screenshot producer failed").strip())


def type_text(window, text: str) -> None:
    tool = xdotool()
    if tool is None:
        fail("xdotool is required for Linux keyboard input")
    focus_window(window)
    result = subprocess.run([tool, "type", "--delay", "0", "--clearmodifiers", text], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
    if result.returncode != 0:
        fail((result.stderr or "xdotool type failed").strip())


def press_key(window, key: str, modifiers: str) -> None:
    tool = xdotool()
    if tool is None:
        fail("xdotool is required for Linux keyboard input")
    names = {
        "enter": "Return", "return": "Return", "escape": "Escape", "esc": "Escape",
        "tab": "Tab", "backspace": "BackSpace", "delete": "Delete", "left": "Left",
        "right": "Right", "up": "Up", "down": "Down", "home": "Home", "end": "End",
        "pageup": "Page_Up", "pagedown": "Page_Down", "space": "space",
    }
    lower = key.lower()
    key_name = names.get(lower, key if len(key) == 1 else None)
    if key_name is None:
        fail(f"unsupported key: {key}")
    modifier_names = {"cmd": "super", "shift": "shift", "ctrl": "ctrl", "opt": "alt", "alt": "alt"}
    prefix: list[str] = []
    for raw in [item.strip().lower() for item in modifiers.split(",") if item.strip()]:
        if raw == "fn":
            fail("fn modifier is not supported by the Linux AT-SPI helper")
        if raw not in modifier_names:
            fail(f"unsupported modifier: {raw}")
        prefix.append(modifier_names[raw])
    chord = "+".join(prefix + [key_name])
    focus_window(window)
    result = subprocess.run([tool, "key", "--clearmodifiers", chord], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
    if result.returncode != 0:
        fail((result.stderr or "xdotool key failed").strip())


if len(sys.argv) < 2:
    fail("missing command")
command = sys.argv[1]
options = parse_options(sys.argv[2:])

if command == "doctor":
    try:
        pyatspi.Registry.getDesktop(0)
    except Exception as error:
        fail(f"AT-SPI registry is unavailable: {error}")
    print("atspi=available")
    print(f'keyboard_input={"available" if keyboard_backend_available() else "unavailable"}')
    backend = screenshot_backend()
    print(f'screenshot={"available" if backend else "unavailable"}')
    if backend:
        print(f"screenshot_backend={backend[1]}")
    raise SystemExit(0)

timeout = float(str(options.get("timeout", "15")))
window, pid = wait_window(options, timeout)

if command == "wait-window":
    if options.get("print-pid") and pid is not None:
        print(pid)
elif command == "focus":
    focus_window(window)
elif command == "inspect":
    depth = int(str(options.get("depth", "10")))
    limit = int(str(options.get("limit", "80")))
    for accessible, path_value in walk(window, depth, limit):
        print(format_record(accessible, path_value))
elif command == "describe":
    element = find_element(window, options)
    path_value = str(options.get("path", "match"))
    print(json.dumps(record(element, path_value), sort_keys=True, separators=(",", ":")))
elif command == "screenshot":
    capture_window(window, require_option(options, "out"))
elif command == "click":
    click_element(find_element(window, options))
elif command == "set-value":
    set_value(find_element(window, options), require_option(options, "value"))
elif command == "type":
    type_text(window, require_option(options, "text"))
elif command == "key":
    press_key(window, require_option(options, "key"), str(options.get("modifiers", "")))
else:
    fail(f"unsupported command: {command}")
