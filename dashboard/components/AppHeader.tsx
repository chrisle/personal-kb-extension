type ActivePage = "wiki" | "meeting" | "queue" | "log" | "settings";

interface AppHeaderProps {
  active?: ActivePage;
}

export function AppHeader({ active }: AppHeaderProps) {
  return (
    <header className="app-header">
      <a className="header-title-btn" href="/">Personal Knowledge Base</a>
      <nav className="header-nav">
        <a className={`nav-btn${active === "wiki" ? " active" : ""}`} href="/wiki">Wiki</a>
        <a className={`nav-btn${active === "meeting" ? " active" : ""}`} href="/meeting">Meeting</a>
        <a className={`nav-btn${active === "queue" ? " active" : ""}`} href="/queue">Queue</a>
        <a className={`nav-btn${active === "log" ? " active" : ""}`} href="/log">Log</a>
        <a className={`nav-btn${active === "settings" ? " active" : ""}`} href="/settings">Settings</a>
      </nav>
    </header>
  );
}
