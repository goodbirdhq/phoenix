import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Folder, Monitor, ShieldCheck } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Brand } from "~/components/brand";

export const Route = createFileRoute("/")({ component: Home });
function Home() {
  return (
    <div className="landing">
      <header className="landing-header">
        <Brand />
        <nav>
          <Link to="/login">Log in</Link>
          <Button variant="outline" nativeButton={false} render={<Link to="/signup" />}>
            Create account <ArrowRight size={15} />
          </Button>
        </nav>
      </header>
      <main>
        <div className="hero">
          <span className="eyebrow">
            <span className="status-dot" /> YOUR PHOENIX, TOGETHER
          </span>
          <h1>
            A home for
            <br />
            your next <em>idea.</em>
          </h1>
          <p>
            Organize your workspaces and keep track of the machines you build on. Your Phoenix
            account brings it all together.
          </p>
          <div className="hero-actions">
            <Button size="lg" nativeButton={false} render={<Link to="/signup" />}>
              Get started <ArrowRight size={18} />
            </Button>
            <Link className="quiet-link" to="/login">
              Already have an account?
            </Link>
          </div>
          <span className="hero-note">Open source at the core. Built for your workflow.</span>
        </div>
        <section className="feature-grid" aria-label="What you can do">
          <article>
            <Folder />
            <h2>Room for every project</h2>
            <p>Create named workspaces to organize your work in one place.</p>
          </article>
          <article>
            <Monitor />
            <h2>Know your devices</h2>
            <p>Keep a record of your desktop and remote server installations.</p>
          </article>
          <article>
            <ShieldCheck />
            <h2>Your own space</h2>
            <p>Your workspaces and device records belong to your account.</p>
          </article>
        </section>
      </main>
      <footer>
        PHOENIX CLOUD <span>Build something that matters.</span>
      </footer>
    </div>
  );
}
