import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import {
  ActivatedCommandRegistry, prepareIsolatedCommand, type CommandResult, type CommandRoots,
} from "../actions/commands.js";
import { monitorIsolatedCommand } from "../actions/isolated-process.js";
import { credentialEnvironmentName } from "../brokers/environment.js";
import type { CredentialBroker } from "../brokers/ports.js";
import { ShipperError } from "../errors.js";
import { OpaqueCredential, consumeOpaqueCredential } from "../security/opaque-credential.js";

export interface OperationalCommandResult extends CommandResult {
  /** Private capture bytes; the engine removes these before persistence. */
  stdoutBytes: Buffer;
}

/** Typed boundary for contract-declared post-merge operations and their probes. */
export class PostMergeAdapter {
  constructor(
    private readonly registry: ActivatedCommandRegistry,
    private readonly broker: CredentialBroker,
  ) {}

  async execute(
    commandId: string,
    values: Record<string, string>,
    roots: CommandRoots,
    context: { projectId: string; workRunId: string; dataRoot: string },
  ): Promise<OperationalCommandResult> {
    const command = this.registry.get(commandId);
    for (const [name, policy] of Object.entries(command.parameters)) {
      if (policy.pathRoot !== "runtime_data") continue;
      const value = values[name];
      const relation = value === undefined ? "" : relative(resolve(context.dataRoot), resolve(value));
      if (value === undefined || !isAbsolute(value) || !relation || relation.startsWith("..") || isAbsolute(relation)) {
        throw new ShipperError(`${command.id}: ${name} must remain under the runtime data root`, 4);
      }
    }

    const credentials: OpaqueCredential[] = [];
    const environment: NodeJS.ProcessEnv = this.registry.childEnvironment(command, roots);
    const secretValues: string[] = [];
    try {
      for (const referenceId of command.credentialRefs) {
        const handle = await this.broker.acquire({
          referenceId, purpose: "post_merge_operation", projectId: context.projectId, workRunId: context.workRunId,
        });
        if (!(handle instanceof OpaqueCredential)) {
          handle.dispose();
          throw new ShipperError(`${command.id}: credential broker returned an unsupported handle`, 4);
        }
        credentials.push(handle);
        consumeOpaqueCredential(handle, (secret) => {
          environment[credentialEnvironmentName(referenceId)] = secret;
          secretValues.push(secret);
        });
      }

      const invocation = prepareIsolatedCommand(command, values, roots, context.dataRoot);
      this.registry.assertAuthorizationSourcesUnchanged(invocation.authorizationRoot);
      const child = spawn(invocation.executable, invocation.args, {
        cwd: invocation.cwd, env: environment, shell: false,
        detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      });
      const result = await monitorIsolatedCommand(
        child,
        invocation,
        () => this.registry.assertAuthorizationSourcesUnchanged(invocation.authorizationRoot),
        true,
      );
      if (secretValues.some((secret) => result.stdout.includes(secret) || result.stderr.includes(secret))) {
        throw new ShipperError(`${command.id}: credential material appeared in command output`, 4);
      }
      return result;
    } finally {
      for (const credential of credentials) credential.dispose();
    }
  }
}
