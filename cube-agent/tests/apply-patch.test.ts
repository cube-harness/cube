import assert from "node:assert/strict";
import test from "node:test";
import { parsePatch, applyFilePatch } from "../src/tools/apply-patch.js";

test("patch parser preserves Codex hunks, optional first marker and EOF anchoring", () => {
  for (const header of ["@@\n", ""]) {
    const change = parsePatch(`*** Begin Patch\n*** Update File: a\n${header}-same\n+last\n*** End of File\n*** End Patch`).hunks[0];
    assert.equal(change.type, "update");
    assert.equal(applyFilePatch("same\nmiddle\nsame\n", change as never), "same\nmiddle\nlast\n");
    assert.equal(applyFilePatch("same", change as never), "last");
  }
  const unicode = parsePatch('*** Begin Patch\n*** Update File: a\n@@\n-"hello"\n+ok\n*** End Patch').hunks[0];
  assert.equal(applyFilePatch("“hello”\n", unicode as never), "ok\n");
  for (const body of ["garbage", "*** Add File: a\nnot-prefixed", "*** Update File: a\n@@\ngarbage", "*** Update File: a", "*** Update File: a\n*** Move to:"]) {
    assert.throws(() => parsePatch(`*** Begin Patch\n${body}\n*** End Patch`));
  }
  assert.throws(() => parsePatch("prefix\n*** Begin Patch\n*** Delete File: a\n*** End Patch"));
});
