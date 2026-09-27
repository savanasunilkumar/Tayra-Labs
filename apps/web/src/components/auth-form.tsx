"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ArrowLeft, Eye, EyeOff, Loader2 } from "lucide-react";
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User,
} from "firebase/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authMessage, authRequest, identityClient } from "@/lib/auth-client";
import type { AuthConfig } from "@/lib/auth-types";

export function AuthForm({
  mode,
  config,
}: {
  mode: "login" | "signup" | "forgot-password";
  config: AuthConfig;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [verify, setVerify] = useState<User | null>(null);
  const [resent, setResent] = useState(false);
  const signup = mode === "signup";
  const reset = mode === "forgot-password";

  async function finish(user: User) {
    await user.reload();
    if (!user.emailVerified) {
      setVerify(user);
      setPassword("");
      return;
    }
    await authRequest("session", { id_token: await user.getIdToken(true) });
    await signOut(identityClient(config));
    try {
      localStorage.setItem("tayra-account-event", crypto.randomUUID());
    } catch {
      /* Optional cross-tab refresh. */
    }
    window.location.replace("/overview");
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
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
  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const auth = identityClient(config);
      if (reset) {
        try {
          await sendPasswordResetEmail(auth, email.trim());
        } catch (error) {
          if ((error as { code?: string }).code !== "auth/user-not-found")
            throw error;
        }
        setNotice(
          "If an account exists for this email, you’ll receive a password reset link shortly.",
        );
        return;
      }
      const credential = signup
        ? await createUserWithEmailAndPassword(auth, email.trim(), password)
        : await signInWithEmailAndPassword(auth, email.trim(), password);
      if (signup) {
        await updateProfile(credential.user, { displayName: name.trim() });
        setVerify(credential.user);
        setPassword("");
        await sendEmailVerification(credential.user);
        setNotice("Verification email sent. Check your inbox and spam folder.");
      } else await finish(credential.user);
    });
  }
  return (
    <main className="auth-page">
      <Link
        href="/login"
        className="auth-brand"
        aria-label="Tayra Labs sign in"
      >
        <img src="/tayra-logo.svg" alt="" />
        <span>Tayra Labs</span>
      </Link>
      <div className="auth-panel">
        <div className="auth-heading">
          <h1>
            {verify
              ? "Check your email"
              : reset
                ? "Reset your password"
                : signup
                  ? "Create your account"
                  : "Log in to Tayra Labs"}
          </h1>
          <p>
            {verify
              ? `Open the verification link sent to ${verify.email}, then continue below.`
              : reset
                ? "We’ll send you a link to choose a new password."
                : signup
                  ? "Your workspace for video intelligence."
                  : "Welcome back to your workspace."}
          </p>
        </div>
        {!config.configured && (
          <p className="auth-notice" role="status">
            Sign-in is being configured. Please check back shortly.
          </p>
        )}
        {verify ? (
          <div className="auth-form">
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await verify.reload();
                  if (!verify.emailVerified)
                    throw new Error(
                      "Your email isn’t verified yet. Open the link in your inbox first.",
                    );
                  await finish(verify);
                })
              }
            >
              {busy && <Loader2 className="animate-spin" />}I’ve verified my
              email
            </Button>
            <Button
              variant="outline"
              disabled={busy || resent}
              onClick={() =>
                void run(async () => {
                  await sendEmailVerification(verify);
                  setResent(true);
                  setNotice(
                    "A new verification email has been sent. Check your spam folder too.",
                  );
                })
              }
            >
              {resent ? "Email sent" : "Resend verification email"}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await signOut(identityClient(config));
                  setVerify(null);
                  setResent(false);
                })
              }
            >
              <ArrowLeft />
              Back to sign in
            </Button>
          </div>
        ) : (
          <>
            {!reset && (
              <>
                <Button
                  variant="outline"
                  className="w-full h-10"
                  disabled={busy || !config.configured || !config.googleEnabled}
                  onClick={() =>
                    void run(async () => {
                      const provider = new GoogleAuthProvider();
                      provider.setCustomParameters({
                        prompt: "select_account",
                      });
                      await finish(
                        (
                          await signInWithPopup(
                            identityClient(config),
                            provider,
                          )
                        ).user,
                      );
                    })
                  }
                >
                  Continue with Google
                </Button>
                <div className="auth-divider">
                  <span>or continue with email</span>
                </div>
              </>
            )}
            <form onSubmit={submit} className="auth-form">
              {signup && (
                <div className="auth-field">
                  <label htmlFor="name">Full name</label>
                  <Input
                    id="name"
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={80}
                    disabled={busy}
                  />
                </div>
              )}
              <div className="auth-field">
                <label htmlFor="email">Email</label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  maxLength={254}
                  disabled={busy}
                />
              </div>
              {!reset && (
                <div className="auth-field">
                  <div className="flex items-center justify-between">
                    <label htmlFor="password">Password</label>
                    {!signup && (
                      <Link
                        href="/forgot-password"
                        className="auth-link text-xs"
                      >
                        Forgot password?
                      </Link>
                    )}
                  </div>
                  <div className="relative">
                    <Input
                      id="password"
                      type={visible ? "text" : "password"}
                      autoComplete={
                        signup ? "new-password" : "current-password"
                      }
                      className="pr-10"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={signup ? 12 : 1}
                      maxLength={128}
                      disabled={busy}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="absolute right-1 top-1 text-muted-foreground"
                      aria-label={visible ? "Hide password" : "Show password"}
                      onClick={() => setVisible(!visible)}
                    >
                      {visible ? <EyeOff /> : <Eye />}
                    </Button>
                  </div>
                  {signup && (
                    <p className="text-xs text-muted-foreground">
                      Use at least 12 characters.
                    </p>
                  )}
                </div>
              )}
              <Button
                type="submit"
                className="h-10 mt-1"
                disabled={busy || !config.configured}
              >
                {busy && <Loader2 className="animate-spin" />}
                {reset
                  ? "Send reset link"
                  : signup
                    ? "Create account"
                    : "Log in"}
              </Button>
            </form>
          </>
        )}
        {error && (
          <p role="alert" className="auth-error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="auth-notice">
            {notice}
          </p>
        )}
        {!verify && (
          <p className="auth-footer">
            {reset ? (
              <Link href="/login" className="auth-link">
                Back to log in
              </Link>
            ) : signup ? (
              <>
                Already have an account?{" "}
                <Link href="/login" className="auth-link">
                  Log in
                </Link>
              </>
            ) : (
              <>
                New to Tayra Labs?{" "}
                <Link href="/signup" className="auth-link">
                  Create an account
                </Link>
              </>
            )}
          </p>
        )}
      </div>
    </main>
  );
}
