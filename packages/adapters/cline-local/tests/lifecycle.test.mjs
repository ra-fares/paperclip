import test from "node:test";
import assert from "node:assert/strict";
import { applyClineLifecycleInstructions } from "../dist/index.js";

test("Cline receives clean-completion instructions on every turn", () => {
  const input = {
    paperclipSessionHandoffMarkdown: "Existing handoff note."
  };

  const output = applyClineLifecycleInstructions(input);
  const handoff = String(output.paperclipSessionHandoffMarkdown ?? "");

  assert.match(handoff, /Existing handoff note/);
  assert.match(handoff, /After a successful terminal PATCH/);
  assert.match(handoff, /do not invoke any more tools/);
  assert.match(handoff, /finish the ACP turn immediately/);

  assert.deepEqual(input, {
    paperclipSessionHandoffMarkdown: "Existing handoff note."
  });
});
