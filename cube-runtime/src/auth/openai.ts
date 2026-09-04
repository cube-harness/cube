import crypto from "node:crypto";
import http, { type Server } from "node:http";

export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const OPENAI_SCOPE = "openid profile email offline_access";
export const OPENAI_JWT_CLAIM_PATH = "https://api.openai.com/auth";
export const OPENAI_CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

