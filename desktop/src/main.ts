import { mount } from "svelte";
import App from "./App.svelte";
import "@fontsource/outfit/400.css";
import "@fontsource/outfit/500.css";
import "@fontsource/outfit/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "./styles.css";

const target = document.getElementById("app");
if (!target) throw new Error("missing #app mount target");

mount(App, { target });
