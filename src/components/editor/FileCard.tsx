import { memo, useEffect, useState } from "react";
import { Node, type JSONContent } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { PaperclipIcon } from "../icons";
import { assetFilePath } from "../../lib/assetPaths";

// Sizes by absolute path. Asset names are never reused, so a size stays right.
const sizes = new Map<string, Promise<number | null>>();

function assetSize(path: string): Promise<number | null> {
  let size = sizes.get(path);
  if (!size) {
    size = invoke<number>("get_asset_size", { path }).catch(() => null);
    sizes.set(path, size);
  }
  return size;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const FileCardView = memo(function FileCardView({ node }: ReactNodeViewProps) {
  const href: unknown = node.attrs.href;
  const name: unknown = node.attrs.name;
  const path = typeof href === "string" ? assetFilePath(href) : null;
  const [bytes, setBytes] = useState<number | null>(null);

  useEffect(() => {
    if (!path) return undefined;
    let current = true;
    void assetSize(path).then((size) => {
      if (current) setBytes(size);
    });
    return () => {
      current = false;
    };
  }, [path]);

  const open = () => {
    if (!path) return;
    invoke("open_asset", { path }).catch((error: unknown) => {
      console.error("Failed to open file:", error);
      // The backend says why, such as refusing to run an executable
      toast.error(
        typeof error === "string" ? error : "Could not open the file",
      );
    });
  };

  return (
    <NodeViewWrapper data-file-card="" className="file-card">
      <button type="button" contentEditable={false} onClick={open}>
        <PaperclipIcon className="w-5 h-5 stroke-[1.6] text-text-muted shrink-0" />
        <span className="file-card-name">
          {typeof name === "string" ? name : ""}
        </span>
        {bytes !== null && (
          <span className="file-card-size">{formatSize(bytes)}</span>
        )}
      </button>
    </NodeViewWrapper>
  );
});

/**
 * A file in `assets/`, stored as a paragraph holding only a link to it.
 * `href` is the display URL; assetPaths maps it to and from the stored path.
 * Cards come only from such links (assetPaths checks they point into
 * `assets/`), never from HTML, whose `data-href` could open any file.
 */
export const FileCard = Node.create({
  name: "fileCard",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      href: { default: null, rendered: false },
      name: { default: "", rendered: false },
    };
  },

  renderHTML({ node }) {
    return [
      "div",
      {
        "data-file-card": "",
        "data-href": node.attrs.href,
        "data-name": node.attrs.name,
      },
      node.attrs.name,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FileCardView);
  },

  renderMarkdown(node: JSONContent, h) {
    const { href, name } = node.attrs ?? {};
    return h.renderChildren([
      { type: "text", text: name, marks: [{ type: "link", attrs: { href } }] },
    ]);
  },
});
