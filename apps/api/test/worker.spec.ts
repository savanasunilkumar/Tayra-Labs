import { env, exports } from "cloudflare:workers";
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("Inqox API", () => {
  it("reports health without authentication", async () => {
    const response = await exports.default.fetch("https://api.example.com/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok", service: "inqox-api" });
  });

  it("rejects an unauthenticated API request", async () => {
    const response = await exports.default.fetch("https://api.example.com/v1/assets");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "unauthorized" } });
  });

  it("rejects unknown routes", async () => {
    const response = await exports.default.fetch("https://api.example.com/does-not-exist");
    expect(response.status).toBe(404);
  });

  it("creates and completes a direct-upload asset", async () => {
    const createResponse = await exports.default.fetch("https://api.example.com/v1/assets", {
      method: "POST",
      headers: {
        authorization: "Bearer test-api-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        filename: "sample.mp4",
        content_type: "video/mp4",
        size_bytes: 4,
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json<{
      asset: { id: string; status: string };
      upload: { method: string; url: string };
    }>();
    expect(created.asset.status).toBe("pending_upload");
    expect(created.upload.method).toBe("PUT");
    expect(created.upload.url).toContain("X-Amz-Signature=");

    await env.MEDIA.put(`source/default/${created.asset.id}/original.mp4`, new Uint8Array([1, 2, 3, 4]), {
      httpMetadata: { contentType: "video/mp4" },
    });
    const completeResponse = await exports.default.fetch(
      `https://api.example.com/v1/assets/${created.asset.id}/complete`,
      {
        method: "POST",
        headers: { authorization: "Bearer test-api-key" },
      },
    );
    expect(completeResponse.status).toBe(200);
    await expect(completeResponse.json()).resolves.toMatchObject({ asset: { status: "ready", actual_bytes: 4 } });
  });

  it("removes expired source objects during scheduled maintenance", async () => {
    const assetId = crypto.randomUUID();
    const objectKey = `source/default/${assetId}/original.mp4`;
    const past = "2026-01-01T00:00:00.000Z";
    await env.DB.prepare(
      `INSERT INTO assets
        (id, object_key, filename, content_type, expected_bytes, actual_bytes, status, created_at, updated_at, retention_until)
       VALUES (?, ?, 'expired.mp4', 'video/mp4', 4, 4, 'ready', ?, ?, ?)`,
    )
      .bind(assetId, objectKey, past, past, past)
      .run();
    await env.MEDIA.put(objectKey, new Uint8Array([1, 2, 3, 4]));

    const controller = createScheduledController({ scheduledTime: new Date("2026-09-20T00:00:00Z") });
    const context = createExecutionContext();
    await worker.scheduled(controller, env, context);
    await waitOnExecutionContext(context);

    expect(await env.MEDIA.head(objectKey)).toBeNull();
    const asset = await env.DB.prepare("SELECT status FROM assets WHERE id = ?")
      .bind(assetId)
      .first<{ status: string }>();
    expect(asset?.status).toBe("deleted");
  });
});
