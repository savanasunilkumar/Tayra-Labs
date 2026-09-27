"use client";
import { Button } from "@/components/ui/button";
import { logout } from "@/lib/auth-client";
import { useState } from "react";
export default function WorkspaceError({ reset }: { reset: () => void }) {
  const [error, setError] = useState("");
  return (
    <main className="auth-page">
      <div className="auth-panel">
        <div className="auth-heading">
          <h1>Workspace unavailable</h1>
          <p>
            We couldn’t verify your session or load your account. Your data
            hasn’t been changed.
          </p>
        </div>
        <div className="flex justify-center gap-2">
          <Button onClick={reset}>Try again</Button>
          <Button
            variant="outline"
            onClick={() =>
              void logout().catch(() =>
                setError("Could not sign out. Please try again."),
              )
            }
          >
            Log out
          </Button>
        </div>
        {error && (
          <p role="alert" className="auth-error">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
