import { cookies } from "next/headers";
import { backendJson, BackendError } from "@/lib/backend";
import {
  boundedJson,
  SESSION_COOKIE,
  trustedMutation,
} from "@/lib/auth-policy";
import { currentAccount } from "@/lib/session";
import {
  limitedStream,
  ownedStorageUrl,
  workspaceRoute,
} from "@/lib/workspace-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers });
}
async function forward(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const path = (await context.params).path.join("/");
  if (!workspaceRoute(request.method, path))
    return json({ error: "Endpoint not found." }, 404);
  if (request.method !== "GET" && !trustedMutation(request))
    return json({ error: "Request origin is not allowed." }, 403);
  if (request.headers.get("sec-fetch-site") === "cross-site")
    return json({ error: "Request origin is not allowed." }, 403);
  try {
    const user = await currentAccount();
    if (!user) return json({ error: "Please sign in to continue." }, 401);
    if (!user.email_verified)
      return json({ error: "Verify your email before continuing." }, 403);
    const session = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!session) return json({ error: "Please sign in to continue." }, 401);
    if (path === "session")
      return json({
        user,
        token: "",
        model: "elanus-1-8b",
        project: "video-api-dev-509820",
        api_base_url: process.env.TAYRA_API_URL,
        api_iam: process.env.TAYRA_API_IAM === "true",
        sample_available: false,
        saved_job: "",
      });
    if (path === "health")
      return json(await backendJson("/health", {}, session));
    if (request.method === "PUT") {
      const id = path.split("/")[1];
      const ticket = await backendJson<{
        asset: { expected_bytes: number; content_type: string };
        upload: { url: string };
      }>(`/v1/assets/${id}/upload-url`, { method: "POST" }, session);
      const length = Number(request.headers.get("content-length"));
      if (
        !request.body ||
        !Number.isSafeInteger(length) ||
        length < 1 ||
        length > 500 * 1024 * 1024 ||
        length !== ticket.asset.expected_bytes
      )
        return json(
          { error: "Upload size does not match the registered video." },
          413,
        );
      if (request.headers.get("content-type") !== ticket.asset.content_type)
        return json(
          { error: "Upload type does not match the registered video." },
          415,
        );
      const url = ownedStorageUrl(
        ticket.upload.url,
        user.workspace_id,
        id,
        "source",
      );
      const init: RequestInit & { duplex: "half" } = {
        method: "PUT",
        duplex: "half",
        body: limitedStream(request.body, length, true),
        headers: {
          "Content-Type": ticket.asset.content_type,
          "Content-Length": String(length),
          "x-goog-if-generation-match": "0",
        },
        redirect: "error",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(660000)]),
      };
      const upload = await fetch(url, init);
      if (!upload.ok && upload.status !== 412)
        throw new BackendError(502, "Upload did not complete. Please retry.");
      return json(
        await backendJson(
          `/v1/assets/${id}/complete`,
          { method: "POST" },
          session,
        ),
      );
    }
    if (path.endsWith("/result")) {
      const ticket = await backendJson<{ result_url: string }>(
        `/v1/${path}`,
        {},
        session,
      );
      const url = ownedStorageUrl(
        ticket.result_url,
        user.workspace_id,
        path.split("/")[1],
        "result",
      );
      const result = await fetch(url, {
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(30000),
      });
      if (!result.ok || !result.body)
        throw new BackendError(502, "The result could not be loaded.");
      return json(
        await new Response(limitedStream(result.body, 1024 * 1024)).json(),
      );
    }
    const init: RequestInit = {
      method: request.method,
      headers: { "Content-Type": "application/json" },
    };
    if (
      ["assets", "jobs", "me"].includes(path) &&
      ["POST", "PATCH"].includes(request.method)
    ) {
      let body;
      try {
        body = await boundedJson(request);
      } catch {
        return json({ error: "A valid JSON request is required." }, 400);
      }
      init.body = JSON.stringify(body);
    }
    if (path === "jobs" && request.method === "POST") {
      const key = request.headers.get("idempotency-key") ?? "";
      if (!/^[\w.-]{8,128}$/.test(key))
        return json({ error: "A valid idempotency key is required." }, 400);
      (init.headers as Record<string, string>)["Idempotency-Key"] = key;
    }
    const value = await backendJson<Record<string, unknown>>(
      `/v1/${path}`,
      init,
      session,
    );
    if (path === "assets" && request.method === "POST")
      return json({ asset: value.asset }, 201);
    return json(value);
  } catch (error) {
    return json(
      {
        error:
          error instanceof BackendError
            ? error.message
            : "The request could not be completed. Please try again.",
      },
      error instanceof BackendError ? error.status : 502,
    );
  }
}
export {
  forward as GET,
  forward as POST,
  forward as PUT,
  forward as PATCH,
  forward as DELETE,
};
