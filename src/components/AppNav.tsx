import { Button } from "./controls.js";
import { Icon, type IconName } from "./icons.js";

export type NavSection = "decks" | "ug" | "graph" | "songs";

/** Every item goes somewhere real. Library is the screen titled that; the study tool it hides is the harmonic graph. */
export const NAV_ITEMS: Array<{ section: NavSection; label: string; icon: IconName }> = [
  { section: "decks", label: "Presentations", icon: "folder" },
  { section: "ug", label: "Chord & Tabs", icon: "guitar" },
  { section: "graph", label: "Song Study Tools", icon: "study" },
  { section: "songs", label: "Library", icon: "library" },
];

export function AppNav({ active, onGo }: { active: NavSection; onGo: (section: NavSection) => void }) {
  return (
    <nav className="app-nav" aria-label="Sections">
      {NAV_ITEMS.map(({ section, label, icon }) => (
        <Button
          key={section}
          variant="subtle"
          className="nav-item"
          aria-label={label}
          aria-current={section === active ? "page" : undefined}
          onClick={() => onGo(section)}
        >
          <Icon name={icon} size={18} />
          <span className="nav-label">{label}</span>
        </Button>
      ))}
    </nav>
  );
}
