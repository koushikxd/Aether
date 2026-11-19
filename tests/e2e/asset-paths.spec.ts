// Pure checks of src/lib/assetPaths.ts for cases the E2E fake cannot reach
// (Windows paths and URL forms). Runs in Node, no browser.
import { expect, test } from "@playwright/test";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import type { JSONContent } from "@tiptap/core";
import {
  type NoteLocation,
  withDisplaySrcs,
  withRelativeSrcs,
} from "../../src/lib/assetPaths";

// @tauri-apps/api keeps its internals on `window`.
Object.assign(globalThis, { window: globalThis });

const MAC: NoteLocation = { notesFolder: "/Users/k/Notes", noteId: "a/b/Note" };
const WIN: NoteLocation = {
  notesFolder: "C:\\Users\\k\\Notes",
  noteId: "a/b/Note",
};

function docWithImage(src: string): JSONContent {
  return {
    type: "doc",
    content: [
      { type: "blockquote", content: [{ type: "image", attrs: { src } }] },
    ],
  };
}

function imageSrc(doc: JSONContent): unknown {
  return doc.content?.[0].content?.[0].attrs?.src;
}

const load = (src: string, at: NoteLocation) =>
  imageSrc(withDisplaySrcs(docWithImage(src), at));
const save = (src: string, at: NoteLocation) =>
  imageSrc(withRelativeSrcs(docWithImage(src), at));
const mac = (path: string) => `asset://localhost/${encodeURIComponent(path)}`;
const win = (path: string, scheme = "http") =>
  `${scheme}://asset.localhost/${encodeURIComponent(path)}`;

test.describe("Windows", () => {
  test.beforeEach(() => mockConvertFileSrc("windows"));

  test("legacy http and https asset URLs inside the folder become relative", () => {
    const file = "C:\\Users\\k\\Notes\\assets\\x.png";
    expect(save(win(file), WIN)).toBe("../../assets/x.png");
    expect(save(win(file, "https"), WIN)).toBe("../../assets/x.png");
    expect(load(win(file, "https"), WIN)).toBe(win(file));
  });

  test("relative paths load as Windows display URLs", () => {
    expect(load("../../assets/x.png", WIN)).toBe(
      win("C:\\Users\\k\\Notes\\assets\\x.png"),
    );
  });

  test("files outside the notes folder stay untouched", () => {
    const outside = win("C:\\Users\\k\\Notes-old\\assets\\x.png");
    expect(save(outside, WIN)).toBe(outside);
    expect(load(outside, WIN)).toBe(outside);
    expect(load("D:\\pics\\x.png", WIN)).toBe("D:\\pics\\x.png");
  });
});

test.describe("macOS and Linux", () => {
  test.beforeEach(() => mockConvertFileSrc("macos"));

  test("a note at the root uses assets/ and sibling folders keep the short form", () => {
    const root = { ...MAC, noteId: "Note" };
    expect(save(mac("/Users/k/Notes/assets/x.png"), root)).toBe("assets/x.png");
    expect(save(mac("/Users/k/Notes/a/b/img/x.png"), MAC)).toBe("img/x.png");
    expect(save(mac("/Users/k/Notes/a/c/x.png"), MAC)).toBe("../c/x.png");
  });

  test("names with spaces and link-breaking characters round-trip", () => {
    const file = "/Users/k/Notes/assets/my shot (1)#2.png";
    const stored = "../../assets/my%20shot%20%281%29%232.png";
    expect(save(mac(file), MAC)).toBe(stored);
    expect(load(stored, MAC)).toBe(mac(file));
    expect(save(mac("/Users/k/Notes/assets/日本.png"), MAC)).toBe(
      "../../assets/日本.png",
    );
  });

  test("paths that escape the notes folder stay untouched", () => {
    expect(load("../../../x.png", MAC)).toBe("../../../x.png");
    const sneaky = mac("/Users/k/Notes/../secret.png");
    expect(save(sneaky, MAC)).toBe(sneaky);
  });

  test("URLs, absolute paths, anchors and bad encodings stay untouched", () => {
    for (const src of [
      "https://example.com/x.png",
      "data:image/png;base64,AAAA",
      "/Users/k/Notes/assets/x.png",
      "#top",
      "100%.png",
      "",
    ]) {
      expect(load(src, MAC)).toBe(src);
      expect(save(src, MAC)).toBe(src);
    }
  });

  test("without a note location nothing changes", () => {
    const src = mac("/Users/k/Notes/assets/x.png");
    expect(imageSrc(withRelativeSrcs(docWithImage(src), null))).toBe(src);
    expect(imageSrc(withDisplaySrcs(docWithImage("x.png"), null))).toBe(
      "x.png",
    );
  });
});
