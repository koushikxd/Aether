import * as ContextMenu from "@radix-ui/react-context-menu";
import { useVault } from "../../context/VaultContext";
import { LockIcon } from "../icons";

interface PrivacyMenuItemProps {
  id: string;
  title: string;
  className: string;
}

/** Make private, Make public, or (on a sub-page of a private page) why it cannot be made public. */
export function PrivacyMenuItem({
  id,
  title,
  className,
}: PrivacyMenuItemProps) {
  const { privateIds, privateRoots, makePrivate, makePublic } = useVault();
  const icon = <LockIcon className="w-4 h-4 stroke-[1.6]" />;

  if (privateRoots.has(id)) {
    return (
      <ContextMenu.Item
        className={className}
        onSelect={() => makePublic(id, title)}
      >
        {icon}
        Make public
      </ContextMenu.Item>
    );
  }
  if (privateIds.has(id)) {
    const root = [...privateRoots].find((r) => id.startsWith(`${r}/`));
    return (
      <ContextMenu.Item
        disabled
        className={`${className} items-start data-[disabled]:cursor-default data-[disabled]:hover:bg-transparent`}
      >
        {icon}
        <span className="flex flex-col opacity-50">
          Make public
          {root && (
            <span className="text-2xs text-text-muted">
              {root.split("/").pop()} is private, so this page is too
            </span>
          )}
        </span>
      </ContextMenu.Item>
    );
  }
  return (
    <ContextMenu.Item
      className={className}
      onSelect={() => void makePrivate([id])}
    >
      {icon}
      Make private
    </ContextMenu.Item>
  );
}
