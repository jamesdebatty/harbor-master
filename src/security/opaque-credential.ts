export interface SecretRegistrar {
  registerSecret(value: string): () => void;
}

const material = new WeakMap<OpaqueCredential, string>();

export class OpaqueCredential {
  readonly #releaseSecret: () => void;

  private constructor(
    readonly referenceId: string,
    value: string,
    registrar: SecretRegistrar,
  ) {
    if (value.length === 0) throw new Error("credential material cannot be empty");
    material.set(this, value);
    this.#releaseSecret = registrar.registerSecret(value);
  }

  static create(referenceId: string, value: string, registrar: SecretRegistrar): OpaqueCredential {
    return new OpaqueCredential(referenceId, value, registrar);
  }

  dispose(): void {
    if (!material.delete(this)) return;
    this.#releaseSecret();
  }

  toJSON(): never {
    throw new Error("opaque credentials cannot be serialized");
  }
}

export function consumeOpaqueCredential(credential: OpaqueCredential, consumer: (value: string) => void): void {
  const value = material.get(credential);
  if (value === undefined) throw new Error("opaque credential has been disposed");
  consumer(value);
}
