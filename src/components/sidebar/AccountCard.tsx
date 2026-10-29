import { memo, useEffect, useRef } from "react";
import { LogOut, MoreVertical, User, UserPlus } from "lucide-react";
import type { UserProfile } from "../../lib/search";

interface AccountCardProps {
  profile: UserProfile | null;
  isLoggedIn: boolean;
  isLoggingIn: boolean;
  authSyncError: string | null;
  isMenuOpen: boolean;
  onMenuOpenChange: (open: boolean | ((open: boolean) => boolean)) => void;
  onRetrySync: () => void;
  onSignIn: (switchAccount: boolean) => void;
  onSignOut: () => void;
}

/** Account card at the foot of the sidebar, with its popover menu. */
export const AccountCard = memo(function AccountCard({
  profile,
  isLoggedIn,
  isLoggingIn,
  authSyncError,
  isMenuOpen,
  onMenuOpenChange,
  onRetrySync,
  onSignIn,
  onSignOut,
}: AccountCardProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Close the popover on a click anywhere outside it.
  useEffect(() => {
    if (!isMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onMenuOpenChange(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [isMenuOpen, onMenuOpenChange]);

  const signIn = (switchAccount: boolean) => {
    onMenuOpenChange(false);
    onSignIn(switchAccount);
  };

  return (
    <div className="sidebar-account-container" ref={containerRef}>
      {isMenuOpen && (
        <div className="apple-profile-popover" role="dialog" aria-label="Account details">
          {isLoggedIn && (
            <div className="popover-user-row">
              {profile?.avatarUrl ? (
                <img
                  src={profile.avatarUrl}
                  alt={profile.name}
                  className="popover-avatar"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="popover-avatar-placeholder">
                  <User size={16} />
                </div>
              )}
              <div className="popover-user-text">
                <span className="popover-user-name">{profile?.name || "Connected Account"}</span>
                {profile?.email && <span className="popover-user-email">{profile.email}</span>}
              </div>
            </div>
          )}

          <div className="popover-badge-row">
            <span className={`popover-status-badge ${isLoggedIn ? "online" : "offline"}`}>
              <span className={`nothing-status-dot ${isLoggedIn ? "online" : "offline"}`} />
              <span>{isLoggedIn ? "YouTube Music" : "Offline"}</span>
            </span>
          </div>

          <div className="popover-divider" />

          {authSyncError && (
            <div
              className="popover-sync-error"
              style={{
                padding: "8px 12px",
                fontSize: "11px",
                color: "var(--red-primary, #ff0055)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>{authSyncError}</span>
              <button
                type="button"
                onClick={onRetrySync}
                style={{
                  background: "rgba(255,255,255,0.1)",
                  border: "none",
                  color: "#fff",
                  borderRadius: 4,
                  padding: "2px 8px",
                  cursor: "pointer",
                  fontSize: "10px",
                }}
              >
                Retry
              </button>
            </div>
          )}

          <div className="popover-actions">
            {isLoggedIn ? (
              <>
                <button
                  type="button"
                  className="popover-switch-btn"
                  disabled={isLoggingIn}
                  onClick={() => signIn(true)}
                >
                  <UserPlus size={14} strokeWidth={2} />
                  <span>{isLoggingIn ? "Connecting…" : "Switch Account"}</span>
                </button>

                <button type="button" className="popover-signout-btn" onClick={onSignOut}>
                  <LogOut size={14} strokeWidth={2} />
                  <span>Sign Out</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                className="popover-switch-btn"
                disabled={isLoggingIn}
                onClick={() => signIn(false)}
              >
                <UserPlus size={14} strokeWidth={2} />
                <span>{isLoggingIn ? "Connecting…" : "Sign In with Google"}</span>
              </button>
            )}
          </div>
        </div>
      )}

      <div
        className={`sidebar-account-card ${isLoggedIn ? "connected" : "guest"}`}
        onClick={() => {
          if (!isLoggedIn) onSignIn(false);
          else if (authSyncError) onRetrySync();
          else onMenuOpenChange((open) => !open);
        }}
        role="button"
        tabIndex={0}
        aria-label="Account details"
      >
        <div className="account-avatar-wrapper">
          {profile?.avatarUrl ? (
            <img
              src={profile.avatarUrl}
              alt={profile.name}
              className="account-avatar-img"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="account-avatar-fallback">
              <User size={18} strokeWidth={1.8} />
            </div>
          )}
          <span className={`account-status-indicator ${isLoggedIn ? "online" : "offline"}`} />
        </div>

        <div className="account-details-col">
          <span className="account-display-name">
            {isLoggingIn
              ? "Connecting..."
              : authSyncError
                ? "Sync Incomplete"
                : isLoggedIn
                  ? profile?.name || "Connected User"
                  : "Sign In"}
          </span>
          <span className="account-sub-label">
            {isLoggingIn
              ? "Authenticating with Google"
              : authSyncError
                ? "Tap to retry"
                : isLoggedIn
                  ? profile?.email || "YouTube Music"
                  : "Personalize feed & history"}
          </span>
        </div>

        <button
          type="button"
          className="account-dots-btn"
          aria-label="Account options"
          onClick={(e) => {
            e.stopPropagation();
            onMenuOpenChange((open) => !open);
          }}
        >
          <MoreVertical size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
});
