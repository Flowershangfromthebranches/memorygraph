import type { ProjectPrivacyPolicy } from "../domain/types.js";

const SENSITIVE_KEY = /(?:^|[_-])(authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|private[_-]?key)(?:$|[_-])/iu;
const SECRET_VALUE = /\b(?:sk|rk|pk|ghp|github_pat|xox[baprs]|AIza)[-_][A-Za-z0-9_-]{12,}\b/gu;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}\b/giu;

export function redactText(value: string, maxLength = 4_000): string {
  const redacted = value.replace(SECRET_VALUE, "[REDACTED_SECRET]").replace(BEARER_VALUE, "Bearer [REDACTED]");
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength)}…[truncated ${redacted.length - maxLength} chars]`;
}

export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 7) return "[truncated depth]";
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value).slice(0, 100)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(nested, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function summarize(value: string, maxLength = 320): string {
  return redactText(value.replace(/\s+/gu, " ").trim(), maxLength);
}

function excluded(value: string, patterns: string[]): boolean {
  const normalized = value.toLocaleLowerCase().replaceAll("\\", "/");
  return patterns.some((pattern) => {
    const token = pattern.toLocaleLowerCase().replaceAll("\\", "/").replace(/^\*+|\*+$/gu, "");
    return token.length > 0 && normalized.includes(token);
  });
}

export function sanitizeForPolicy(value: unknown, policy: ProjectPrivacyPolicy, depth = 0): unknown {
  if (depth > 7) return "[truncated depth]";
  if (typeof value === "string") return excluded(value, policy.excludedPathPatterns) ? "[EXCLUDED_BY_PROJECT_POLICY]" : redactText(value, policy.maxMessageChars);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeForPolicy(item, policy, depth + 1));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value).slice(0, 100)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeForPolicy(nested, policy, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function protectedMessage(role: string, body: string, policy: ProjectPrivacyPolicy): { summary: string; payload: Record<string, unknown> } {
  if (!policy.storeMessageContent) {
    return {
      summary: `${role}: [message content excluded by project privacy policy]`,
      payload: { role, contentStored: false, originalCharacters: body.length },
    };
  }
  return {
    summary: `${role}: ${summarize(body)}`,
    payload: { role, contentStored: true, text: summarize(body, policy.maxMessageChars) },
  };
}
