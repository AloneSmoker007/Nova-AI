process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "ci-test-secret-minimum-32-chars-long";
process.env.JWT_ISSUER = "nova-ai";
process.env.JWT_AUDIENCE = "nova-ai-api";
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.WEBHOOK_VERIFY_TOKEN = "test-webhook-verify-token";
process.env.META_APP_SECRET = "0123456789abcdef0123456789abcdef";
process.env.CREDENTIAL_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
