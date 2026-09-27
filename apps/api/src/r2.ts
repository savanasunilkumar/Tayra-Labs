import { AwsClient } from "aws4fetch";

type SignedMethod = "GET" | "PUT";

export async function signR2ObjectUrl(
  env: Env,
  objectKey: string,
  method: SignedMethod,
  expiresInSeconds: number,
  contentType?: string,
): Promise<string> {
  const client = new AwsClient({
    service: "s3",
    region: "auto",
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });
  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
  const url = new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${encodeURIComponent(env.R2_BUCKET_NAME)}/${encodedKey}`,
  );
  url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));

  const headers = new Headers();
  if (contentType) headers.set("content-type", contentType);
  const signed = await client.sign(new Request(url, { method, headers }), {
    aws: { signQuery: true },
  });
  return signed.url;
}

