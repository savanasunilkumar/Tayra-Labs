"use client";
import { useState, type FormEvent } from "react";
import { sendPasswordResetEmail } from "firebase/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useWorkspace } from "./workspace-provider";
import { api } from "@/lib/api";
import { authMessage, identityClient, logout } from "@/lib/auth-client";
import type { Account } from "@/lib/auth-types";

export function AccountSettings() {
  const { user, setUser, authConfig } = useWorkspace();
  const [name, setName] = useState(user.display_name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState(false);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (error) {
      setError(authMessage(error));
    } finally {
      setBusy(false);
    }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const result = await api<{ user: Account }>("me", "", {
        method: "PATCH",
        body: JSON.stringify({ display_name: name.trim() }),
      });
      setUser(result.user);
      setNotice("Profile updated.");
    });
  }
  return (
    <>
      <section className="settings-section">
        <h3 className="section-label">Account</h3>
        <form className="auth-form max-w-sm" onSubmit={save}>
          <div className="auth-field">
            <label htmlFor="profile-name">Full name</label>
            <Input
              id="profile-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="name"
              maxLength={80}
              required
              disabled={busy}
            />
          </div>
          <div className="auth-field">
            <label htmlFor="profile-email">Email</label>
            <Input id="profile-email" value={user.email} readOnly />
            <p className="text-xs text-muted-foreground">
              Verified · Managed by your sign-in provider
            </p>
          </div>
          <Button
            type="submit"
            className="w-fit"
            size="sm"
            disabled={busy || !name.trim() || name.trim() === user.display_name}
          >
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </form>
      </section>
      <section className="settings-section">
        <h3 className="section-label">Security</h3>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await sendPasswordResetEmail(
                  identityClient(authConfig),
                  user.email,
                );
                setNotice(
                  "If password sign-in is available for this account, a reset link will arrive in your inbox.",
                );
              })
            }
          >
            Reset password
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setConfirm(true)}
          >
            Log out of all devices
          </Button>
        </div>
        <p className="settings-note">
          Sessions expire after five days. Logging out of all devices revokes
          every current Tayra session.
        </p>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="settings-note" role="status">
            {notice}
          </p>
        )}
      </section>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent className="sm:max-w-sm">
          <DialogTitle>Log out everywhere?</DialogTitle>
          <DialogDescription>
            You’ll be signed out on this device and all other devices. Sign in
            again to access your workspace.
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await logout(true);
                })
              }
            >
              {busy ? "Signing out…" : "Log out everywhere"}
            </Button>
          </div>
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
