export function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized === "authorization"
    || normalized === "cookie"
    || normalized === "setcookie"
    || normalized.endsWith("secret")
    || normalized.endsWith("token")
    || normalized.endsWith("password")
    || normalized.endsWith("privatekey")
    || normalized.endsWith("apikey")
    || normalized.endsWith("credentialvalue");
}
