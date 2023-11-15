/**
 * @file Exposes API for CloudWatch-related operations.
 */

import { CloudWatchLogsClient, CreateLogGroupCommand, DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";

/**
 * Retrieve the CloudWatch log group by name, or create one first if it
 * does not exist.
 * 
 * @param {import("@aws-sdk/client-cloudwatch-logs").CloudWatchLogsClientConfig} awsConfig
 * CloudWatch client configuration.
 * 
 * @param {string} logGroupName
 * CloudWatch log group name. The default value is `/aws/datasync`.
 */
export async function getOrCreateLogGroup(awsConfig, logGroupName = '/aws/datasync') {
  const cloudwatch = new CloudWatchLogsClient(awsConfig);

  return await getCloudWatchLogGroup(logGroupName, cloudwatch)
    ?? await createCloudWatchLogGroup(logGroupName, cloudwatch);
}

/**
 * Get a CloudWatch log group.
 * 
 * @param {string} logGroupName Log group name to retrieve.
 * @param {CloudWatchLogsClient} cloudwatch CloudWatch service to search log group from.
 * @returns Log group for DataSync if present, or `null`.
 */
async function getCloudWatchLogGroup(logGroupName, cloudwatch) {
  const command = new DescribeLogGroupsCommand({
    logGroupNamePattern: logGroupName
  });

  const { logGroups } = await cloudwatch.send(command);
  return logGroups?.[0] ?? null;
}

/**
 * Create the CloudWatch log group to use for logging DataSync operations.
 * 
 * @param {string} logGroupName Log group name to create.
 * @param {CloudWatchLogsClient} cloudwatch CloudWatch service to create the log group in.
 * @returns Newly created log group.
 */
async function createCloudWatchLogGroup(logGroupName, cloudwatch) {
  const command = new CreateLogGroupCommand({
    logGroupName: logGroupName
  });

  await cloudwatch.send(command);
  const newLogGroup = await getCloudWatchLogGroup(logGroupName, cloudwatch);
  
  if(!newLogGroup) {
    const message = 'CloudWatch log group for DataSync creation failed.';
    const cause = `The created CloudWatch log group "${logGroupName}" is not found.`;
    throw new Error(message, { cause });
  }

  return newLogGroup;
}