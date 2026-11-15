import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    env: {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test",
      DEEPGRAM_API_KEY: "test",
      ANTHROPIC_API_KEY: "test",
      AZURE_SPEECH_KEY: "test",
      AZURE_SPEECH_REGION: "eastus",
      LOG_LEVEL: "silent",
      SUPABASE_JWT_SECRET: "test-secret-test-secret-test-secret",
    },
  },
});
