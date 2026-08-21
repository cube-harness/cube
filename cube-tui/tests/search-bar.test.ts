import assert from "node:assert/strict";
import test from "node:test";
import { SearchBar } from "../src/components/search-bar.js";

test("SearchBar renders placeholder when empty and typed query when populated", () => {
  const search = new SearchBar({ placeholder: "Type to filter..." });
  let lines = search.render(80);
  assert.equal(lines.length > 0, true);
  assert.ok(lines[0]?.includes("Type to filter..."));

  search.appendChar("a");
  search.appendChar("u");
  search.appendChar("t");
  search.appendChar("h");

  assert.equal(search.getQuery(), "auth");
  lines = search.render(80);
  assert.ok(lines[0]?.includes("auth"));

  search.backspace();
  assert.equal(search.getQuery(), "aut");

  search.clear();
  assert.equal(search.getQuery(), "");
  lines = search.render(80);
  assert.ok(lines[0]?.includes("Type to filter..."));
});
