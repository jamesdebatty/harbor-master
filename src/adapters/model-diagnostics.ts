export const SUBSCRIPTION_CLI_DIAGNOSTICS = [
  "no_stderr", "auth", "rate_limit", "network", "service_unavailable",
  "model_unavailable", "invalid_cli_argument", "filesystem", "unclassified",
] as const;

export type SubscriptionCliDiagnostic = typeof SUBSCRIPTION_CLI_DIAGNOSTICS[number];

export function subscriptionCliDetails(
  exitStatus: number,
  category: SubscriptionCliDiagnostic,
): [string, string] {
  return [
    `subscription_cli_exit_status:${exitStatus}`,
    `subscription_cli_diagnostic:${category}`,
  ];
}
