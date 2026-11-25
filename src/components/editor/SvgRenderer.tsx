import { useState } from "react";

interface SvgRendererProps {
  code: string;
}

const messageClass =
  "text-xs text-text-muted italic px-2 pt-6 pb-3 text-center";

// Loaded as an <img>, the SVG cannot run scripts or fetch external resources.
// Never insert it into the DOM.
export function SvgRenderer({ code }: SvgRendererProps) {
  const [failedCode, setFailedCode] = useState<string | null>(null);

  if (!code.trim()) {
    return <div className={messageClass}>Empty SVG</div>;
  }

  if (failedCode === code) {
    return <div className={messageClass}>Invalid SVG</div>;
  }

  return (
    <div className="flex justify-center py-2">
      <img
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`}
        alt="SVG preview"
        className="max-w-full h-auto"
        onError={() => setFailedCode(code)}
      />
    </div>
  );
}
