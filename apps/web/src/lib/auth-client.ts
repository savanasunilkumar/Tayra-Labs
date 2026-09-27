"use client";

import { getApps, initializeApp } from "firebase/app";
import {
  initializeAuth,
  inMemoryPersistence,
  browserPopupRedirectResolver,
  type Auth,
} from "firebase/auth";
import type { AuthConfig } from "./auth-types";

let client: Auth | undefined;
export function identityClient(config: AuthConfig) {
  if (!config.configured) throw new Error("Sign-in is not configured yet.");
  if (!client) {
    const app =
      getApps().find((app) => app.name === "tayra") ??
      initializeApp(config.firebase, "tayra");
    client = initializeAuth(app, {
      persistence: inMemoryPersistence,
      popupRedirectResolver: browserPopupRedirectResolver,
    });
  }
  return client;
}

export function authMessage(error: unknown) {
  const code = (error as { code?: string })?.code;
  if (
    [
      "auth/invalid-credential",
      "auth/user-not-found",
      "auth/wrong-password",
      "auth/user-disabled",
    ].includes(code ?? "")
  )
    return "We couldn’t sign you in. Check your email and password, or reset your password.";
  if (code === "auth/email-already-in-use")
    return "We couldn’t create this account. Try signing in or resetting your password.";
  if (
    code === "auth/weak-password" ||
    code === "auth/password-does-not-meet-requirements"
  )
    return "Use at least 12 characters and meet the password requirements.";
  if (code === "auth/too-many-requests")
    return "Too many attempts. Please wait a few minutes and try again.";
  if (
    code === "auth/popup-closed-by-user" ||
    code === "auth/cancelled-popup-request"
  )
    return "Google sign-in was cancelled. You can try again.";
  if (code === "auth/popup-blocked")
    return "Allow pop-ups for this site to continue with Google.";
  if (
    code === "auth/unauthorized-domain" ||
    code === "auth/operation-not-allowed"
  )
    return "This sign-in method is not configured for this site yet.";
  if (code === "auth/network-request-failed")
    return "Check your connection and try again.";
  if (code) return "Sign-in could not be completed. Please try again.";
  return error instanceof Error ? error.message : "Please try again.";
}

export async function authRequest(
  action: "session" | "logout" | "logout-all",
  body?: object,
) {
  const response = await fetch(`/api/auth/${action}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-Tayra-Client": "workspace",
    },
    body: JSON.stringify(body ?? {}),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error ?? "Unable to complete this request.");
  return value;
}

export async function logout(everywhere = false) {
  await authRequest(everywhere ? "logout-all" : "logout");
  if (client) await client.signOut();
  try {
    localStorage.setItem("tayra-account-event", crypto.randomUUID());
  } catch {
    /* Storage is optional. */
  }
  window.location.replace("/login");
}
