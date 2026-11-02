import { mount } from "svelte";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "./styles.css";

const target = document.getElementById("app");
if (!target) throw new Error("missing #app mount target");

if (new URLSearchParams(window.location.search).get("imageViewer") === "1") {
  const { default: ImageViewerWindow } = await import("./components/ImageViewerWindow.svelte");
  mount(ImageViewerWindow, { target });
} else {
  const { default: App } = await import("./App.svelte");
  mount(App, { target });
}
