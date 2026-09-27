const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export function workspaceRoute(method: string, path: string) {
  const rules = [
    ["GET", /^(session|health|jobs|me)$/],
    ["PATCH", /^me$/],
    ["POST", /^(assets|jobs)$/],
    ["PUT", new RegExp(`^assets/${UUID}/content$`, "i")],
    ["DELETE", new RegExp(`^assets/${UUID}$`, "i")],
    ["GET", new RegExp(`^jobs/${UUID}(/result)?$`, "i")],
    ["POST", new RegExp(`^jobs/${UUID}/cancel$`, "i")],
  ] as const;
  return rules.some(([verb, pattern]) => method === verb && pattern.test(path));
}
export function ownedStorageUrl(
  value: string,
  workspace: string,
  id: string,
  kind: "source" | "result",
) {
  const url = new URL(value);
  const bucket =
    process.env.TAYRA_MEDIA_BUCKET ?? "video-api-dev-509820-video-api-media";
  const prefix = `/${bucket}/${kind}/${workspace}/${id}/`;
  const path = decodeURIComponent(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "storage.googleapis.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !(kind === "result"
      ? path === prefix + "result.json"
      : ["mp4", "mov", "webm"].some(
          (ext) => path === prefix + "original." + ext,
        ))
  )
    throw new Error("Invalid storage destination");
  return url;
}
export function limitedStream(
  body: ReadableStream<Uint8Array>,
  maximum: number,
  exact = false,
) {
  let bytes = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maximum) throw new Error("Upload size exceeded");
        controller.enqueue(chunk);
      },
      flush() {
        if (exact && bytes !== maximum) throw new Error("Upload size mismatch");
      },
    }),
  );
}
export function accountStorageKey(kind: "history" | "pending", uid: string) {
  return `tayra-${kind}:${encodeURIComponent(uid)}`;
}
