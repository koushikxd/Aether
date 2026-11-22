import { useVault } from "../../context/VaultContext";
import { Button } from "../ui";

export function PrivatePagesSection() {
  const { status, generateKey, enterKey, showKey } = useVault();

  return (
    <section className="pb-2">
      <h2 className="text-xl font-medium mb-0.5">Private Pages</h2>
      <p className="text-sm text-text-muted mb-4 max-w-lg">
        Private pages are encrypted before they are committed, so only devices
        with your key can read them. Right-click a page in the sidebar to make
        it private.
      </p>
      {status &&
        (!status.hasVault ? (
          <Button onClick={() => void generateKey()} variant="outline">
            Generate key
          </Button>
        ) : status.unlocked ? (
          <Button onClick={() => void showKey()} variant="outline">
            Show key
          </Button>
        ) : (
          <Button onClick={enterKey} variant="outline">
            Enter key
          </Button>
        ))}
    </section>
  );
}
