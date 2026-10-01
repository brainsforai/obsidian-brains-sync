import { describe, expect, it } from "vitest";
import { filePathToPageName, pageNameToTitle, pageToFilePath } from "../src/pathMapping";

describe("pageToFilePath", () => {
  it("appends .md when the page name has no extension", () => {
    expect(pageToFilePath("brains", "notes/todo")).toBe("brains/notes/todo.md");
  });

  it("does not double-append .md when the page name already ends in .md", () => {
    expect(pageToFilePath("brains", "notes/todo.md")).toBe("brains/notes/todo.md");
  });

  it("handles a top-level page name with no nesting", () => {
    expect(pageToFilePath("brains", "todo")).toBe("brains/todo.md");
  });

  it("handles deeply nested page names", () => {
    expect(pageToFilePath("brains", "a/b/c/d")).toBe("brains/a/b/c/d.md");
  });
});

describe("filePathToPageName", () => {
  it("strips the folder prefix and .md suffix", () => {
    expect(filePathToPageName("brains", "brains/notes/todo.md")).toBe("notes/todo");
  });

  it("leaves the name untouched if it has no .md suffix", () => {
    expect(filePathToPageName("brains", "brains/notes/todo")).toBe("notes/todo");
  });

  it("handles a top-level file with no nesting", () => {
    expect(filePathToPageName("brains", "brains/todo.md")).toBe("todo");
  });

  it("handles deeply nested file paths", () => {
    expect(filePathToPageName("brains", "brains/a/b/c/d.md")).toBe("a/b/c/d");
  });

  it("round-trips with pageToFilePath for nested names", () => {
    const pageName = "projects/foo/bar";
    const filePath = pageToFilePath("brains", pageName);
    expect(filePathToPageName("brains", filePath)).toBe(pageName);
  });
});

describe("pageNameToTitle", () => {
  it("takes the final path segment", () => {
    expect(pageNameToTitle("projects/foo/bar-baz")).toBe("bar baz");
  });

  it("replaces runs of dashes and underscores with a single space", () => {
    expect(pageNameToTitle("my--weird__title")).toBe("my weird title");
  });

  it("falls back to the full name when cleaning produces an empty string", () => {
    expect(pageNameToTitle("---")).toBe("---");
  });

  it("handles a top-level name with no path segments", () => {
    expect(pageNameToTitle("todo")).toBe("todo");
  });
});
