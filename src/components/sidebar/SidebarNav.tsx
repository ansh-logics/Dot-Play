import { memo } from "react";
import { HelpCircle, History, Home, Library, Search, Settings } from "lucide-react";
import type { NavTab } from "../../views/types";

interface SidebarNavProps {
  activeNav: NavTab;
  hasSearchQuery: boolean;
  hasOpenPlaylist: boolean;
  isSupportOpen: boolean;
  isSettingsOpen: boolean;
  onNavigate: (tab: NavTab) => void;
  onOpenSupport: () => void;
  onOpenSettings: () => void;
}

interface NavItemProps {
  label: string;
  icon: typeof Home;
  active: boolean;
  onClick: () => void;
}

function NavItem({ label, icon: Icon, active, onClick }: NavItemProps) {
  return (
    <button type="button" className={`sidebar-nav-item ${active ? "active" : ""}`} onClick={onClick}>
      <span className="nav-item-indicator" />
      <Icon size={17} strokeWidth={2} className="nav-svg-icon" />
      <span className="nav-item-label">{label}</span>
    </button>
  );
}

export const SidebarNav = memo(function SidebarNav({
  activeNav,
  hasSearchQuery,
  hasOpenPlaylist,
  isSupportOpen,
  isSettingsOpen,
  onNavigate,
  onOpenSupport,
  onOpenSettings,
}: SidebarNavProps) {
  return (
    <nav className="sidebar-nav">
      <span className="nav-group-label">DISCOVER</span>
      <NavItem
        label="Home"
        icon={Home}
        active={activeNav === "home" && !hasSearchQuery}
        onClick={() => onNavigate("home")}
      />
      <NavItem
        label="Search"
        icon={Search}
        active={activeNav === "search" || hasSearchQuery}
        onClick={() => onNavigate("search")}
      />

      <span className="nav-group-label">COLLECTIONS</span>
      <NavItem
        label="Playlists"
        icon={Library}
        active={activeNav === "library" && !hasOpenPlaylist}
        onClick={() => onNavigate("library")}
      />
      <NavItem
        label="History"
        icon={History}
        active={activeNav === "history" && !hasOpenPlaylist}
        onClick={() => onNavigate("history")}
      />

      <span className="nav-group-label">GENERAL</span>
      <NavItem label="Support" icon={HelpCircle} active={isSupportOpen} onClick={onOpenSupport} />
      <NavItem label="Settings" icon={Settings} active={isSettingsOpen} onClick={onOpenSettings} />
    </nav>
  );
});
