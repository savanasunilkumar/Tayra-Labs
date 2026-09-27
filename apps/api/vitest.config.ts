import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            INQOX_API_KEY: "test-api-key",
            RUNPOD_API_KEY: "test-runpod-key",
            R2_ACCOUNT_ID: "test-account-id",
            R2_ACCESS_KEY_ID: "test-access-key",
            R2_SECRET_ACCESS_KEY: "test-secret-key",
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
