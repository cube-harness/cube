import assert from "node:assert/strict";
import test from "node:test";
import * as edit from "../src/tools/edit-text.js";

test("OpenCode replacement handles exact, whitespace, escaped and ambiguous input with guards", () => {
  for (const [content, old, next, expected] of [
    ["one two", "two", "three", "one three"],
    ["  alpha\n  beta\n", "alpha\nbeta", "next", "next\n"],
    ["hello    world", "hello world", "ok", "ok"],
    ["hello\nworld", "hello\\nworld", "ok", "ok"],
  ]) assert.equal(edit.replace(content, old, next), expected);
  assert.equal(edit.replace("x x", "x", "y", true), "y y");
  assert.throws(() => edit.replace("x x", "x", "y"), /multiple/);
  assert.throws(() => edit.replace("x", "absent", "y"), /Could not find/);
  assert.throws(() => edit.replace("x", "x", "x"), /identical/);
  assert.throws(() => edit.replace("x", "", "y"), /empty/);
  assert.throws(() => edit.replace("begin\na\nb\nc\nd\nend", "begin\nend", "oops"));
});

test("ported fallback generators retain their distinct candidate behavior", () => {
  const fixtures = [
    [edit.SimpleReplacer, "one two", "two", "two"],
    [edit.LineTrimmedReplacer, "  a\n  b", "a\nb", "  a\n  b"],
    [edit.BlockAnchorReplacer, "start\nhello world\nend", "start\nhello worlds\nend", "start\nhello world\nend"],
    [edit.WhitespaceNormalizedReplacer, "a   b", "a b", "a   b"],
    [edit.IndentationFlexibleReplacer, "  a\n    b", "a\n  b", "  a\n    b"],
    [edit.EscapeNormalizedReplacer, "a\nb", "a\\nb", "a\nb"],
    [edit.TrimmedBoundaryReplacer, "a\nb", "\na\nb\n", "a\nb"],
    [edit.ContextAwareReplacer, "start\na\nb\nend", "start\na\nx\nend", "start\na\nb\nend"],
    [edit.MultiOccurrenceReplacer, "x x", "x", "x"],
  ] as const;
  for (const [replacer, content, find, expected] of fixtures) assert.ok([...replacer(content, find)].includes(expected), replacer.name);
});
