import { render } from "svelte/server";
import { expect, it } from "vitest";
import ElicitationDialog from "./ElicitationDialog.svelte";

it.each(["confirm", "boolean"] as const)("renders the matching controls for a %s field", (type) => {
  const { body } = render(ElicitationDialog, { props: {
    message: "Change publication scope?",
    field: { key: "value", label: "Change publication scope", type, value: false, options: [] },
    onValueChange: () => {},
    onAnswer: () => {},
  } });
  expect(body).toContain(">Cancel</button>");
  if (type === "confirm") {
    expect(body).toContain(">Confirm</button>");
    expect(body).not.toContain('type="checkbox"');
  } else {
    expect(body).toContain(">Continue</button>");
    expect(body).toContain('type="checkbox"');
  }
});
