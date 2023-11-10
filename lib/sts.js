/**
 * @file API for STS operations.
 */

import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

/**
 * Get AWS account details of the given AWS config.
 * 
 * @param {import("@aws-sdk/client-sts").STSClientConfig} config AWS config.
 * @returns AWS account ID.
 */
export async function getAwsAccountInfo(config) {
  const sts = new STSClient(config);
  const command = new GetCallerIdentityCommand({});
  return sts.send(command);
}