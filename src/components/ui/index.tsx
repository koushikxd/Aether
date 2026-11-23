import * as React from "react";
import { type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Tooltip } from "./Tooltip";
import { ChevronRightIcon, LockIcon, PinIcon } from "../icons";

// Re-export components
export {
  Tooltip,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  TooltipContent,
} from "./Tooltip";
export { Button } from "./Button";
export { CodeCopyButton } from "./CodeCopyButton";
export { Input } from "./Input";
export { Select } from "./Select";
export { Toaster } from "./Toaster";
export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "./AlertDialog";

// Toolbar button with active state and tooltip
interface ToolbarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  isActive?: boolean;
  children: ReactNode;
}

export function ToolbarButton({
  isActive = false,
  className = "",
  children,
  title,
  ...props
}: ToolbarButtonProps) {
  const button = (
    <button
      className={cn(
        "h-7 w-7 flex items-center justify-center text-sm rounded transition-colors shrink-0",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1",
        isActive
          ? "bg-bg-muted text-text"
          : "hover:bg-bg-muted text-text-muted",
        className,
      )}
      tabIndex={-1}
      aria-label={title}
      aria-pressed={isActive}
      {...props}
    >
      {children}
    </button>
  );

  if (title) {
    return <Tooltip content={title}>{button}</Tooltip>;
  }

  return button;
}

// Icon button (for sidebar actions, etc.)
export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  variant?: "primary" | "default" | "secondary" | "ghost" | "outline";
  title?: string;
}

const iconButtonSizes = {
  xs: "w-6 h-6", // 24px
  sm: "w-7 h-7", // 28px
  md: "w-8 h-8", // 32px
  lg: "w-9 h-9", // 36px
  xl: "w-10 h-10", // 40px
};

const iconButtonVariants = {
  primary: "bg-accent text-text-inverse hover:bg-accent/90",
  default: "bg-bg-emphasis text-text hover:bg-bg-muted",
  secondary: "bg-bg-muted text-text hover:bg-bg-emphasis",
  ghost: "hover:bg-bg-muted text-text-muted hover:text-text",
  outline:
    "border border-border text-text-muted hover:bg-bg-muted hover:text-text",
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    { className, children, title, size = "sm", variant = "ghost", ...props },
    ref,
  ) => {
    const button = (
      <button
        ref={ref}
        className={cn(
          "flex items-center justify-center rounded-md transition-colors",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1",
          "disabled:pointer-events-none disabled:opacity-50 cursor-pointer",
          iconButtonSizes[size],
          iconButtonVariants[variant],
          className,
        )}
        tabIndex={-1}
        aria-label={title}
        {...props}
      >
        {children}
      </button>
    );

    if (title) {
      return <Tooltip content={title}>{button}</Tooltip>;
    }

    return button;
  },
);
IconButton.displayName = "IconButton";

// List item for sidebar
interface ListItemProps {
  title: string;
  subtitle?: string;
  meta?: string;
  isSelected?: boolean;
  /** Set in selection mode: whether the row is selected. */
  pressed?: boolean;
  isPinned?: boolean;
  isPrivate?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  /** Optional status icon to display next to meta */
}

export function ListItem({
  title,
  subtitle,
  meta,
  isSelected = false,
  pressed,
  isPinned = false,
  isPrivate = false,
  onClick,
  onContextMenu,
}: ListItemProps & { onContextMenu?: (e: React.MouseEvent) => void }) {
  // Clean subtitle: treat whitespace-only or &nbsp; as empty
  const cleanSubtitle = subtitle
    ?.replace(/&nbsp;/g, " ")
    .replace(/\u00A0/g, " ")
    .trim();
  const hasSubtitle = cleanSubtitle && cleanSubtitle.length > 0;

  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- tabIndex -1 row; keyboard navigation is handled by the note list container and App, so per-row Enter/Space would double-handle
    <div
      onClick={onClick}
      onContextMenu={onContextMenu}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a native button changes click focus (WebKit focuses the list container instead, showing its focus ring) and makes Space activate the row
      role="button"
      aria-pressed={pressed}
      tabIndex={-1}
      className={cn(
        "w-full text-left px-2.5 py-2.25 transition-colors cursor-pointer select-none rounded-md",
        "focus:outline-none focus-visible:outline-none",
        isSelected
          ? "bg-bg-muted group-focus/notelist:ring-1 group-focus/notelist:ring-text-muted"
          : "hover:bg-bg-muted",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 min-w-0">
          {isPinned && (
            <PinIcon className="w-4.25 h-4.25 stroke-[1.6] fill-current text-text-muted shrink-0" />
          )}
          <span className={cn("text-sm font-medium truncate text-text")}>
            {title}
          </span>
        </div>
        {isPrivate && (
          <span data-private-icon className="shrink-0">
            <LockIcon className="w-3.5 h-3.5 stroke-[1.8] text-text-muted" />
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {meta && (
          <div
            className={cn(
              "text-xs whitespace-nowrap",
              isSelected ? "text-text" : "text-text-muted",
            )}
          >
            {meta}
          </div>
        )}
        <p
          className={cn(
            "text-xs line-clamp-1 min-h-5",
            hasSubtitle ? "text-text-muted" : "text-transparent",
            isSelected ? "opacity-100" : "opacity-70",
          )}
        >
          {hasSubtitle ? cleanSubtitle : "\u00A0"}
        </p>
      </div>
    </div>
  );
}

// Command palette item
interface CommandItemProps {
  label: string;
  subtitle?: ReactNode;
  shortcut?: string;
  /** Shows a chevron: the row opens a sub-view. */
  subView?: boolean;
  icon?: ReactNode;
  iconText?: string;
  variant?: "note" | "command";
  isSelected?: boolean;
  onClick?: () => void;
}

export function CommandItem({
  label,
  subtitle,
  shortcut,
  subView,
  icon,
  iconText,
  variant = "command",
  isSelected = false,
  onClick,
}: CommandItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      tabIndex={-1}
      className={cn(
        "w-full text-left px-3 py-2 rounded-lg flex items-center justify-between transition-colors cursor-pointer",
        isSelected ? "bg-bg-muted text-text" : "text-text hover:bg-bg-muted",
      )}
    >
      <div className="flex items-center gap-3 min-w-0">
        {(icon || iconText) && (
          <div
            className={cn(
              "shrink-0 flex items-center justify-center text-text-muted",
              variant === "note" &&
                "w-9 h-9 rounded-md bg-bg-emphasis flex items-center justify-center",
            )}
          >
            {iconText ? (
              <span className="text-xl text-text-muted font-serif">
                {iconText}
              </span>
            ) : (
              icon
            )}
          </div>
        )}
        <div className="flex flex-col min-w-0">
          <span className="text-[15px] font-medium truncate">{label}</span>
          {subtitle && (
            <span className="text-sm truncate text-text-muted">{subtitle}</span>
          )}
        </div>
      </div>
      {shortcut && (
        <kbd
          className={cn(
            "text-xs px-2 py-0.5 rounded-md ml-2",
            isSelected
              ? "bg-bg-muted text-text"
              : "bg-bg-muted text-text-muted",
          )}
        >
          {shortcut}
        </kbd>
      )}
      {subView && (
        <ChevronRightIcon className="w-4 h-4 ml-2 shrink-0 text-text-muted" />
      )}
    </button>
  );
}
