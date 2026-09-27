import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { BackendError, backendJson } from "./backend";
import { SESSION_COOKIE } from "./auth-policy";
import type { Account, AuthConfig } from "./auth-types";

export function authConfig(): AuthConfig {
  const firebase = {
    apiKey: process.env.TAYRA_FIREBASE_API_KEY ?? "",
    authDomain: process.env.TAYRA_FIREBASE_AUTH_DOMAIN ?? "",
    projectId: "video-api-dev-509820",
  };
  return {
    firebase,
    googleEnabled: process.env.TAYRA_GOOGLE_SIGN_IN === "true",
    configured: Boolean(
      firebase.apiKey && firebase.authDomain && process.env.TAYRA_API_URL,
    ),
  };
}

export const currentAccount = cache(async (): Promise<Account | null> => {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!session) return null;
  try {
    return (await backendJson<{ user: Account }>("/v1/me", {}, session)).user;
  } catch (error) {
    if (error instanceof BackendError && error.status === 401) return null;
    throw error;
  }
});

export async function requireAccount() {
  const user = await currentAccount();
  if (!user?.email_verified) redirect("/login");
  return user;
}
