import { createRoot } from "react-dom/client";
import "../styles.css";
import "./options.css";

const Options = () => (
  <main className="options">
    <h1>One-Click HAR settings</h1>
    <p className="muted">There are no settings yet.</p>
  </main>
);

createRoot(document.getElementById("root")!).render(<Options />);
