import { OpaqueCredential, type SecretRegistrar } from "./opaque-credential.js";
import { isSensitiveKey } from "./sensitive-key.js";

export class PersistenceRedactor implements SecretRegistrar {
  readonly #secrets = new Map<string, number>();

  registerSecret(value: string): () => void {
    if (value.length === 0) return () => undefined;
    this.#secrets.set(value, (this.#secrets.get(value) ?? 0) + 1);
    return () => {
      const count = this.#secrets.get(value) ?? 0;
      if (count <= 1) this.#secrets.delete(value);
      else this.#secrets.set(value, count - 1);
    };
  }

  redact(value: unknown): unknown {
    if (value instanceof OpaqueCredential) return "[REDACTED]";
    if (typeof value === "string") {
      let redacted = value;
      for (const secret of this.#secrets.keys()) redacted = redacted.replaceAll(secret, "[REDACTED]");
      return redacted;
    }
    if (Array.isArray(value)) return value.map((item) => this.redact(item));
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        isSensitiveKey(key) ? "[REDACTED]" : this.redact(item),
      ]),
    );
  }

  serialize(value: unknown, space?: string | number): string {
    const serialized = JSON.stringify(this.redact(value), null, space);
    for (const secret of this.#secrets.keys()) {
      if (serialized.includes(secret)) throw new Error("registered secret survived persistence redaction");
    }
    return serialized;
  }
}

export function redactForPersistence(value: unknown): unknown {
  return new PersistenceRedactor().redact(value);
}
