import { mount } from "svelte";
import GitWorkflowFixture from "./GitWorkflowFixture.svelte";
import "../../src/styles.css";

const target = document.getElementById("app");
if (!target) throw new Error("Git workflow smoke mount target is missing");
mount(GitWorkflowFixture, { target });
