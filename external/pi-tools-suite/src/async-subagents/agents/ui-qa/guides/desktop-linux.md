# Desktop detail: Linux AT-SPI

Load this topic only when `selection.guide.topic` is `linux-at-spi`.

The trusted bundled Python helper uses AT-SPI for semantic discovery,
activation, values, text, and state assertions. Runtime availability depends on
the graphical accessibility bus plus compatible `pyatspi` bindings. The QA
child must not install bindings or start/replace the user's desktop bus.

`target.application` may use `pid`, `name`, or a bounded runner-owned `launch`
contract. `bundleId` is not a Linux identity. POSIX launch contracts stay in an
owned detached process group so package-manager wrappers can hand off to a GUI
descendant without escaping scoped cleanup.

Keyboard input is advertised only when the runtime-probed `xdotool` producer is
usable. Exact-window PNG evidence is advertised only when the helper can use a
supported screenshot producer such as `gnome-screenshot` or `scrot`. Window
video is currently unavailable and remains an explicit missing capability.

Use the common desktop semantic actions/selectors and prefer AT-SPI
role/name/state as the oracle. If accessibility bus, bindings, keyboard, or
screenshot producer is missing, preserve the runner's precise capability
blocker instead of silently changing automation strategy.

Cleanup is scoped to the runner-owned POSIX process group; attached applications
remain externally owned.
