import { cookies } from "next/headers";
import { BackendError, backendJson } from "@/lib/backend";
import {
  boundedJson,
  cookieOptions,
  SESSION_COOKIE,
  trustedMutation,
} from "@/lib/auth-policy";
import type { Account } from "@/lib/auth-types";

export const runtime = "nodejs";
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  if (!trustedMutation(request))
    return Response.json(
      { error: "Request origin is not allowed." },
      { status: 403, headers },
    );
  const { action } = await context.params;
  const jar = await cookies();
  try {
    if (action === "session") {
      let body;
      try {
        body = await boundedJson(request);
      } catch {
        return Response.json(
          { error: "Invalid session request." },
          { status: 400, headers },
        );
      }
      if (
        typeof body?.id_token !== "string" ||
        !body.id_token ||
        body.id_token.length > 8192
      )
        return Response.json(
          { error: "A valid sign-in token is required." },
          { status: 400, headers },
        );
      const value = await backendJson<{
        session_cookie: string;
        user: Account;
      }>("/v1/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id_token: body.id_token }),
      });
      if (!value.user.email_verified)
        return Response.json(
          { error: "Verify your email before signing in." },
          { status: 403, headers },
        );
      jar.set(SESSION_COOKIE, value.session_cookie, cookieOptions());
      return Response.json({ user: value.user }, { headers });
    }
    if (action === "logout" || action === "logout-all") {
      const session = jar.get(SESSION_COOKIE)?.value;
      if (action === "logout-all" && session) {
        await backendJson("/v1/auth/logout-all", { method: "POST" }, session);
      }
      jar.set(SESSION_COOKIE, "", { ...cookieOptions(), maxAge: 0 });
      return Response.json({ ok: true }, { headers });
    }
    return Response.json(
      { error: "Endpoint not found." },
      { status: 404, headers },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof BackendError
            ? error.message
            : "Sign-in services are unavailable.",
      },
      { status: error instanceof BackendError ? error.status : 503, headers },
    );
  }
}
