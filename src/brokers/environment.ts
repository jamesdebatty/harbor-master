import type { CredentialBroker, CredentialProbe, CredentialRequest } from "./ports.js";
import { ModelAdapterError } from "../adapters/live-models.js";
import { OpaqueCredential, type SecretRegistrar } from "../security/opaque-credential.js";

export function credentialEnvironmentName(referenceId: string): string {
  return `GRAPH_SHIPPER_CREDENTIAL_${referenceId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

/** Trusted composition-root broker. Values never cross its opaque handle. */
export class EnvironmentCredentialBroker implements CredentialBroker {
  constructor(private readonly registrar: SecretRegistrar) {}

  async probe(request: CredentialRequest): Promise<CredentialProbe> {
    const name = credentialEnvironmentName(request.referenceId);
    if (!process.env[name]) throw new ModelAdapterError("auth", `credential reference ${request.referenceId} is unavailable`);
    return { referenceId: request.referenceId, identity: `environment:${request.referenceId}`, capabilityClasses: [request.purpose] };
  }

  async acquire(request: CredentialRequest): Promise<OpaqueCredential> {
    await this.probe(request);
    const value = process.env[credentialEnvironmentName(request.referenceId)];
    if (!value) throw new ModelAdapterError("auth", `credential reference ${request.referenceId} is unavailable`);
    return OpaqueCredential.create(request.referenceId, value, this.registrar);
  }
}
