import { useId } from "react";
import { useTheme, defaultThemeColors } from "../../context/ThemeContext";
import { Button, CodeCopyButton, IconButton, Input, Select } from "../ui";
import { ColorPicker } from "../ui/ColorPicker";
import type {
  FontFamily,
  TextDirection,
  EditorWidth,
  ThemeColorKey,
} from "../../types/note";
import { ChevronRightIcon, EyeIcon, MinusIcon, PlusIcon } from "../icons";
import { cn } from "../../lib/utils";

// Human-readable labels for theme color keys, grouped logically
const colorLabels: { key: ThemeColorKey; label: string; group: string }[] = [
  // Surfaces
  { key: "bg", label: "Background", group: "Surfaces" },
  { key: "bg-secondary", label: "Sidebar", group: "Surfaces" },
  { key: "bg-muted", label: "Hover & Subtle Fill", group: "Surfaces" },
  { key: "bg-emphasis", label: "Strong Fill", group: "Surfaces" },
  // Text & UI
  { key: "text", label: "Text", group: "Text & UI" },
  { key: "text-muted", label: "Secondary Text", group: "Text & UI" },
  { key: "accent", label: "Primary & Buttons", group: "Text & UI" },
  { key: "border", label: "Borders", group: "Text & UI" },
  { key: "selection", label: "Selection Highlight", group: "Text & UI" },
];

// Text direction options
const textDirectionOptions: { value: TextDirection; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "ltr", label: "LTR" },
  { value: "rtl", label: "RTL" },
];

// Page width options
const editorWidthOptions: { value: EditorWidth; label: string }[] = [
  { value: "narrow", label: "Narrow" },
  { value: "normal", label: "Normal" },
  { value: "wide", label: "Wide" },
  { value: "full", label: "Full" },
  { value: "custom", label: "Custom" },
];

// Font family options
const fontFamilyOptions: { value: FontFamily; label: string }[] = [
  { value: "system-sans", label: "Sans" },
  { value: "serif", label: "Serif" },
  { value: "monospace", label: "Mono" },
];

// Bold weight options (medium excluded for monospace)
const boldWeightOptions = [
  { value: 500, label: "Medium", excludeForMonospace: true },
  { value: 600, label: "Semibold", excludeForMonospace: false },
  { value: 700, label: "Bold", excludeForMonospace: false },
  { value: 800, label: "Extra Bold", excludeForMonospace: false },
];

function findOptionValue<T extends string>(
  options: { value: T }[],
  value: string,
): T | undefined {
  return options.find((opt) => opt.value === value)?.value;
}

export function AppearanceSettingsSection() {
  const {
    theme,
    resolvedTheme,
    setTheme,
    editorFontSettings,
    setEditorFontSetting,
    resetEditorFontSettings,
    textDirection,
    setTextDirection,
    editorWidth,
    setEditorWidth,
    interfaceZoom,
    setInterfaceZoom,
    customEditorWidthPx,
    setCustomEditorWidthPx,
    customColorsLight,
    customColorsDark,
    setCustomColor,
    resetCustomColor,
    resetAllCustomColors,
  } = useTheme();
  const idPrefix = useId();

  // Validated numeric change handler
  const handleNumericChange = (
    field: "baseFontSize" | "lineHeight",
    value: string,
    min: number,
    max: number,
  ) => {
    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(Math.max(parsed, min), max);
    setEditorFontSetting(field, clamped);
  };

  // Check if settings differ from defaults
  const hasCustomFonts =
    editorFontSettings.baseFontFamily !== "system-sans" ||
    editorFontSettings.baseFontSize !== 15 ||
    editorFontSettings.boldWeight !== 600 ||
    editorFontSettings.lineHeight !== 1.6 ||
    textDirection !== "auto" ||
    editorWidth !== "normal" ||
    Math.round(interfaceZoom * 100) !== 100;

  // Filter weight options based on font family
  const isMonospace = editorFontSettings.baseFontFamily === "monospace";
  const availableWeightOptions = boldWeightOptions.filter(
    (opt) => !isMonospace || !opt.excludeForMonospace,
  );

  // Handle font family change - bump up weight if needed
  const handleFontFamilyChange = (newFamily: FontFamily) => {
    setEditorFontSetting("baseFontFamily", newFamily);
    // If switching to monospace and current weight is medium, bump to semibold
    if (newFamily === "monospace" && editorFontSettings.boldWeight === 500) {
      setEditorFontSetting("boldWeight", 600);
    }
  };

  return (
    <div className="space-y-8 py-8">
      {/* Theme Section */}
      <section className="pb-2">
        <h2 className="text-xl font-medium mb-3">Theme</h2>
        <div className="flex gap-2 p-1 rounded-[10px] border border-border">
          {(["light", "dark", "system"] as const).map((mode) => (
            <Button
              key={mode}
              onClick={() => setTheme(mode)}
              variant={theme === mode ? "primary" : "ghost"}
              size="md"
              className="flex-1"
            >
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </Button>
          ))}
        </div>
        {theme === "system" && (
          <p className="mt-3 text-sm text-text-muted">
            Currently using {resolvedTheme} mode based on system preference
          </p>
        )}

        {/* Customize Colors */}
        {theme === "system" ? (
          <div className="mt-4 space-y-2">
            <ColorsExpandable
              label="Customize light colors"
              mode="light"
              customColors={customColorsLight}
              setCustomColor={setCustomColor}
              resetCustomColor={resetCustomColor}
              resetAllCustomColors={resetAllCustomColors}
            />
            <ColorsExpandable
              label="Customize dark colors"
              mode="dark"
              customColors={customColorsDark}
              setCustomColor={setCustomColor}
              resetCustomColor={resetCustomColor}
              resetAllCustomColors={resetAllCustomColors}
            />
          </div>
        ) : (
          <ColorsExpandable
            label="Customize colors"
            mode={resolvedTheme}
            customColors={
              resolvedTheme === "dark" ? customColorsDark : customColorsLight
            }
            setCustomColor={setCustomColor}
            resetCustomColor={resetCustomColor}
            resetAllCustomColors={resetAllCustomColors}
            className="mt-4"
          />
        )}
      </section>

      {/* Divider */}
      <div className="border-t border-border border-dashed" />

      {/* Typography Section */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-xl font-medium">Typography</h2>
          {hasCustomFonts && (
            <Button onClick={resetEditorFontSettings} variant="ghost" size="sm">
              Reset to defaults
            </Button>
          )}
        </div>

        <div className="rounded-[10px] border border-border pl-4 py-3 pr-3 space-y-2">
          {/* Font Family */}
          <div className="flex items-center justify-between">
            <label
              htmlFor={`${idPrefix}-font`}
              className="text-sm text-text font-medium"
            >
              Font
            </label>
            <Select
              id={`${idPrefix}-font`}
              value={editorFontSettings.baseFontFamily}
              onChange={(e) => {
                const family = findOptionValue(
                  fontFamilyOptions,
                  e.target.value,
                );
                if (family) handleFontFamilyChange(family);
              }}
              className="w-40"
            >
              {fontFamilyOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          {/* Base Font Size */}
          <div className="flex items-center justify-between">
            <label
              htmlFor={`${idPrefix}-size`}
              className="text-sm text-text font-medium"
            >
              Size
            </label>
            <div className="relative w-40">
              <Input
                id={`${idPrefix}-size`}
                type="number"
                min="12"
                max="24"
                value={editorFontSettings.baseFontSize}
                onChange={(e) =>
                  handleNumericChange("baseFontSize", e.target.value, 12, 24)
                }
                className="w-full h-9 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>
          </div>

          {/* Bold Weight */}
          <div className="flex items-center justify-between">
            <label
              htmlFor={`${idPrefix}-bold-weight`}
              className="text-sm text-text font-medium"
            >
              Bold Weight
            </label>
            <Select
              id={`${idPrefix}-bold-weight`}
              value={editorFontSettings.boldWeight}
              onChange={(e) =>
                setEditorFontSetting("boldWeight", Number(e.target.value))
              }
              className="w-40"
            >
              {availableWeightOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          {/* Line Height */}
          <div className="flex items-center justify-between">
            <label
              htmlFor={`${idPrefix}-line-height`}
              className="text-sm text-text font-medium"
            >
              Line Height
            </label>
            <div className="relative w-40">
              <Input
                id={`${idPrefix}-line-height`}
                type="number"
                min="1.0"
                max="2.5"
                step="0.1"
                value={editorFontSettings.lineHeight}
                onChange={(e) =>
                  handleNumericChange("lineHeight", e.target.value, 1.0, 2.5)
                }
                className="w-full h-9 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>
          </div>

          {/* Text Direction */}
          <div className="flex items-center justify-between">
            <label
              htmlFor={`${idPrefix}-text-direction`}
              className="text-sm text-text font-medium"
            >
              Text Direction
            </label>
            <Select
              id={`${idPrefix}-text-direction`}
              value={textDirection}
              onChange={(e) => {
                const direction = findOptionValue(
                  textDirectionOptions,
                  e.target.value,
                );
                if (direction) setTextDirection(direction);
              }}
              className="w-40"
            >
              {textDirectionOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          {/* Page Width */}
          <div className="flex items-center justify-between">
            <label
              htmlFor={`${idPrefix}-page-width`}
              className="text-sm text-text font-medium"
            >
              Page Width
            </label>
            <Select
              id={`${idPrefix}-page-width`}
              value={editorWidth}
              onChange={(e) => {
                const width = findOptionValue(
                  editorWidthOptions,
                  e.target.value,
                );
                if (width) setEditorWidth(width);
              }}
              className="w-40"
            >
              {editorWidthOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>
          {editorWidth === "custom" && (
            <div className="flex items-center justify-between">
              <label
                htmlFor={`${idPrefix}-custom-width`}
                className="text-sm text-text font-medium"
              >
                Custom Width
              </label>
              <div className="relative w-40 flex items-center gap-2">
                <Input
                  id={`${idPrefix}-custom-width`}
                  type="number"
                  min="480"
                  max="3840"
                  step="10"
                  value={customEditorWidthPx}
                  onChange={(e) => {
                    const parsed = parseInt(e.target.value, 10);
                    if (Number.isFinite(parsed)) {
                      setCustomEditorWidthPx(
                        Math.min(Math.max(parsed, 480), 3840),
                      );
                    }
                  }}
                  className="w-full h-9 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <span className="text-sm text-text-muted">px</span>
              </div>
            </div>
          )}

          {/* Interface Zoom */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-text font-medium">
              Interface Zoom
            </span>
            <div className="flex items-center gap-1 w-40">
              <IconButton
                variant="outline"
                size="md"
                onClick={() => setInterfaceZoom((prev) => prev - 0.05)}
                disabled={interfaceZoom <= 0.7}
                title="Zoom out"
              >
                <MinusIcon className="w-4 h-4" />
              </IconButton>
              <span className="text-sm font-medium tabular-nums flex-1 text-center">
                {Math.round(interfaceZoom * 100)}%
              </span>
              <IconButton
                variant="outline"
                size="md"
                onClick={() => setInterfaceZoom((prev) => prev + 0.05)}
                disabled={interfaceZoom >= 1.5}
                title="Zoom in"
              >
                <PlusIcon className="w-4 h-4" />
              </IconButton>
            </div>
          </div>
        </div>

        {/* Preview */}
        <div className="mt-3 relative">
          <div className="absolute top-3 left-4 flex items-center text-sm font-medium text-text-muted/70 gap-1">
            <EyeIcon className="w-4.5 h-4.5 stroke-[1.5]" />
            <span>Preview</span>
          </div>
          <div className="border border-border rounded-[10px] bg-bg p-6 pt-20 max-h-160 overflow-hidden rounded-t-lg">
            <div
              className="prose prose-lg dark:prose-invert max-w-xl mx-auto"
              dir={textDirection}
              style={{
                fontFamily:
                  editorFontSettings.baseFontFamily === "system-sans"
                    ? "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
                    : editorFontSettings.baseFontFamily === "serif"
                      ? "ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif"
                      : "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
                fontSize: `${editorFontSettings.baseFontSize}px`,
              }}
            >
              <h1>Keeping a Reading Journal</h1>
              <p>
                A short guide to remembering more of what you read.{" "}
                <strong>Small habits</strong> that add up over a year of books.
              </p>

              <h2>While You Read</h2>
              <ul>
                <li>
                  <strong>Mark the margins</strong> - Underline the lines that
                  stop you
                </li>
                <li>
                  <strong>One note per chapter</strong> - Write it before you
                  turn the page
                </li>
                <li>
                  <strong>Ask a question</strong> - Note what you would ask the
                  author
                </li>
                <li>
                  <strong>Keep a stack</strong> - Leave the next book on top of
                  the last one
                </li>
              </ul>

              <h2>After the Last Page</h2>
              <p>
                Close the book and write a summary from memory. Then compare it
                with your chapter notes and fill in what you missed.
              </p>

              <div className="relative my-1">
                <div className="absolute top-2 right-2 z-10">
                  <CodeCopyButton
                    text={`function finishChapter(book) {
  const note = summarize(book.chapter);
  journal.add(note);
  if (book.hasNextChapter) {
    book.turnPage();
  } else {
    shelf.push(book);
  }
}`}
                  />
                </div>
                <pre className="pt-10">
                  <code>
                    {`function finishChapter(book) {
  const note = summarize(book.chapter);
  journal.add(note);
  if (book.hasNextChapter) {
    book.turnPage();
  } else {
    shelf.push(book);
  }
}`}
                  </code>
                </pre>
              </div>

              <h2>Common Mistakes to Avoid</h2>
              <ol>
                <li>
                  Copying whole passages instead of writing your own words
                </li>
                <li>Waiting until the end of the book to take any notes</li>
                <li>Never coming back to the notes once the book is shelved</li>
              </ol>

              <p>
                Remember:{" "}
                <em>a note you revisit is worth ten you never read again</em>.
                Pick one idea from each book and use it this week.
              </p>
            </div>
          </div>
          {/* Fade overlay - content to muted background */}
          <div className="absolute bottom-0 left-0 right-0 h-40 bg-linear-to-t from-bg to-transparent pointer-events-none" />
        </div>
      </section>
    </div>
  );
}

// Expandable subsection for customizing colors for a single theme mode
function ColorsExpandable({
  label,
  mode,
  customColors,
  setCustomColor,
  resetCustomColor,
  resetAllCustomColors,
  className,
}: {
  label: string;
  mode: "light" | "dark";
  customColors: Partial<Record<ThemeColorKey, string>>;
  setCustomColor: (
    mode: "light" | "dark",
    key: ThemeColorKey,
    value: string,
  ) => void;
  resetCustomColor: (mode: "light" | "dark", key: ThemeColorKey) => void;
  resetAllCustomColors: (mode: "light" | "dark") => void;
  className?: string;
}) {
  const defaults = defaultThemeColors[mode];
  const hasAnyCustom = Object.keys(customColors).length > 0;

  return (
    <details className={cn("text-sm", className)}>
      <summary className="cursor-pointer text-text-muted hover:text-text select-none flex items-center gap-1 font-medium">
        <ChevronRightIcon className="w-3.5 h-3.5 stroke-2 transition-transform [[open]>&]:rotate-90" />
        {label}
        {hasAnyCustom && (
          <Button
            onClick={(e) => {
              e.preventDefault();
              resetAllCustomColors(mode);
            }}
            variant="ghost"
            size="sm"
            className="ml-auto"
          >
            Reset all
          </Button>
        )}
      </summary>
      <div className="mt-2 rounded-[10px] border border-border pl-4 py-3 pr-3 space-y-1.5">
        {colorLabels.map(({ key, label: colorLabel, group }, index) => {
          const showGroup =
            index === 0 || colorLabels[index - 1].group !== group;
          return (
            <div key={key}>
              {showGroup && (
                <div
                  className={`text-base text-text-muted font-medium ${key !== colorLabels[0].key ? "mt-6" : ""} mb-2.5`}
                >
                  {group}
                </div>
              )}
              <div className="flex items-center justify-between">
                <label className="text-sm text-text font-medium">
                  {colorLabel}
                </label>
                <ColorPicker
                  color={customColors[key] ?? defaults[key]}
                  defaultColor={defaults[key]}
                  onChange={(value) => setCustomColor(mode, key, value)}
                  onReset={() => resetCustomColor(mode, key)}
                />
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}
