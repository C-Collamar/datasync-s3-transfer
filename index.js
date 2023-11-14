import { getOrCreateLogGroup } from '#lib/cloudwatch.js';
import { createDataSyncLocation, createTask, startTask } from '#lib/datasync.js';
import { getOrCreateDataSyncRole } from '#lib/iam.js';
import { logger } from '#lib/logger.js';
import { createBucket, extractBucketName, updateDestBucketPolicy } from '#lib/s3.js';
import { getAwsAccountInfo } from '#lib/sts.js';
import { DataSyncClient } from '@aws-sdk/client-datasync';
import { S3Client } from '@aws-sdk/client-s3';

/**
 * AWS client [configuration and credential][1] settings.
 * 
 * [1]: https://docs.aws.amazon.com/sdkref/latest/guide/settings-reference.html#creatingServiceClients
 * 
 * @typedef AwsConfig
 * @property {string} region AWS region.
 * @property {object} credentials AWS client credentials.
 * @property {string} credentials.accessKeyId AWS client access key ID.
 * @property {string} credentials.secretAccessKey AWS client secret access key.
 */

/**
 * @typedef S3BucketLocation
 * @property {string} bucketName S3 bucket name.
 * @property {AwsConfig} awsConfig AWS config whose AWS account is where the bucket is in.
 */

/**
 * Input for DataSync-S3 bucket transfer.
 * @typedef DataSyncS3TransferOptions
 *
 * @property {string} srcCloudWatchLogGroup
 * ARN of an existing CloudWatch log group, where DataSync logs will be recorded
 * into.
 *
 * The log group must be owned by the same AWS account that owns the source S3
 * bucket.
 *
 * @property {string} srcDataSyncPrincipal
 * [AWS principal][1] under the source AWS account (i.e., the same account where
 * the  source S3 bucket belongs to), to be granted `s3:ListBucket` on the the
 * destination bucket.
 *
 * This is useful for finer security control over the destination S3 bucket,
 * [especially for cross-account S3 transfers][2], wherein the source and
 * destination buckets are owned by different AWS accounts. If the buckets
 * belong to the same AWS account, you want to specify the AWS account ID as
 * principal, or a narrower version involving it (e.g., an existing IAM role).
 *
 * [1]: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_principal.html#Principal_specifying
 * [2]: https://docs.aws.amazon.com/datasync/latest/userguide/tutorial_s3-s3-cross-account-transfer.html#s3-s3-cross-account-update-s3-policy-destination-account
 *
 * @property {string} srcDataSyncRole
 * ARN of an existing IAM role that DataSync will assume when executing the
 * transfer task.
 *
 * This role must have the [necessary permissions][1] for the transfer task to
 * execute successfully.
 *
 * [1]: https://docs.aws.amazon.com/datasync/latest/userguide/create-s3-location.html#create-role-manually
 */

/**
 * ARNs of DataSync resources created as a result of a transfer task.
 * @typedef DataSyncS3TransferOutput
 *
 * @property {string} dataSyncSrcLocation DataSync source location ARN.
 * @property {string} dataSyncDestLocation DataSync destination location ARN.
 * @property {string} dataSyncTask ARN of the DataSync transfer task.
 * @property {string} dataSyncTaskExec DataSync task execution ARN.
 */

/**
 * @typedef TransferTaskInput
 * @property {string} srcBucket Bucket name whose objects to copy from.
 * @property {string} destBucket Bucket name to copy objects to.
 * @property {string} taskName Name to assign the DataSync transfer task.
 */

/**
 * @typedef DataSyncS3TransferResources
 * @property {?import('@aws-sdk/client-sts').GetCallerIdentityCommandOutput} srcAccount Source AWS account info.
 * @property {?import('@aws-sdk/client-cloudwatch-logs').LogGroup} dataSyncLogGroup CloudWatch log group for DataSync logging.
 * @property {?import('@aws-sdk/client-iam').Role} dataSyncRole IAM role for DataSync to assume to perform the transfer.
 * @property {?import('@aws-sdk/client-s3').CreateBucketCommandOutput} destBucket Destination S3 bucket to transfer to.
 * @property {?import('@aws-sdk/client-datasync').CreateLocationS3CommandOutput} dataSyncSrc DataSync S3 source location.
 * @property {?import('@aws-sdk/client-datasync').CreateLocationS3CommandOutput} dataSyncDest DataSync S3 destination location.
 * @property {?import('@aws-sdk/client-datasync').CreateTaskCommandOutput} dataSyncTask DataSync S3 transfer task.
 * @property {?import('@aws-sdk/client-datasync').StartTaskExecutionCommandOutput} dataSyncExec DataSync S3 transfer task execution.
 */

/**
 * Create and execute DataSync tasks to transfer S3 objects by iterating a given
 * list of source and destination buckets whose objects to transfer from and to,
 * respectively.
 * 
 * Each iteration processes the next pair of source and destination S3 buckets
 * specified in `transferTasks`, then creates and executes a DataSync task to
 * transfer S3 objects between the buckets.
 * 
 * @param {TransferTaskInput[]} transferTasks
 * List of source and destination buckets where to perform the transfer.
 * 
 * All source S3 buckets must be under the same AWS account that `srcAwsConfig`
 * is configured for. Similarly, their corresponding destination buckets must
 * all be under the same AWS account that the `destAwsConfig` is configured for.
 * 
 * @param {DataSyncS3TransferOptions} options
 * Relevant AWS resources needed to construct and execute a DataSync transfer
 * task for each entry specified in the argument `transferTasks`.
 * 
 * @param {AwsConfig} srcAwsConfig
 * AWS config for the AWS account that owns all source S3 buckets.
 * 
 * @param {AwsConfig} destAwsConfig
 * AWS config for the AWS account that owns all destination S3 buckets.
 * 
 * @returns Resources created as byproduct of each DataSync task execution.
 */
export async function* executeS3DataSyncTransfer(transferTasks, options, srcAwsConfig, destAwsConfig) {
  const srcDataSyncClient = new DataSyncClient(srcAwsConfig);
  const destS3Client = new S3Client(destAwsConfig);
  const results = [];

  for (const task of transferTasks) {
    const result = await executeSingleS3DataSyncTransfer(
      task.taskName,
      task.srcBucket,
      task.destBucket,
      options,
      destS3Client,
      srcDataSyncClient
    );

    results.push(result);
    yield result;
  }

  return results;
}

/**
 * Create and execute a DataSync task to transfer S3 objects from source to
 * a destination bucket.
 * 
 * Each DataSync transfer from source to destination S3 buckt creates the
 * following DataSync resources, in order:
 * 1. DataSync source location, pointing to the source S3 bucket;
 * 1. DataSync destination location, pointing to the destination S3 bucket;
 * 1. DataSync task, with the proper transfer configurations; and
 * 1. DataSync task execution, which is the execution of the created DataSync
 * task.
 * 
 * @param {string} taskName
 * name to assign to the DataSync transfer task.

 * @param {string} srcBucket
 * Existing S3 bucket name where objects will be copied from.
 *
 * The source bucket must belong to the same AWS account that the
 * `srcDatasyncClient` argument is configured for.
 *
 * @param {string} destBucket
 * Non-existent S3 bucket name where objects will be copied to.
 *
 * The destination bucket must belong to the same AWS account that the
 * `destS3Client` argument is configured for.
 * 
 * @param {DataSyncS3TransferOptions} options
 * 
 * @param {S3Client} destS3Client
 * Client for the S3 service of the same AWS account that owns the destination
 * bucket.
 * 
 * @param {DataSyncClient} srcDataSyncClient
 * Client for the DataSync service of the same AWS account that owns the source
 * bucket.
 * 
 * @returns Resources created as byproduct of the DataSync task execution.
 */
async function executeSingleS3DataSyncTransfer(taskName, srcBucket, destBucket, options, destS3Client, srcDataSyncClient) {
  /**
   * @type {Partial<DataSyncS3TransferOutput>}.
   */
  const output = {};

  logger.debug(`Initiating transfer from bucket "${srcBucket}" to "${destBucket}"...`);

  // prepare destination bucket
  logger.debug(`Creating destination S3 bucket "${destBucket}"...`);
  try {
    await createBucket(destBucket, destS3Client);
  }
  catch (e) {
    logger.error(`Failed to create S3 bucket.`, e);
    return output;
  }

  // update destination bucket policy
  logger.debug(`Updating policy for bucket "${destBucket}...`);
  try {
    await updateDestBucketPolicy(
      destBucket,
      options.srcDataSyncPrincipal,
      options.srcDataSyncRole,
      destS3Client
    );
  }
  catch (e) {
    logger.error(`Failed to update bucket policy.`, e);
    return output;
  }

  // create datasync S3 source
  logger.debug(`Creating DataSync S3 location for source bucket "${srcBucket}"...`);
  try {
    let response = await createDataSyncLocation(
      `arn:aws:s3:::${srcBucket}`,
      options.srcDataSyncRole,
      srcDataSyncClient
    );

    if (!response.LocationArn) {
      throw new Error(
        'DataSync location ARN not found.',
        { cause: 'No ARN returned from server.' }
      );
    }

    output.dataSyncSrcLocation = response.LocationArn;
  }
  catch (e) {
    logger.error(`Failed to create DataSync source location.`, e);
    return output;
  }

  // create datasync s3 destination
  logger.debug(`Creating DataSync S3 location for destination bucket "${destBucket}"...`);
  try {
    let response = await createDataSyncLocation(
      `arn:aws:s3:::${destBucket}`,
      options.srcDataSyncRole,
      srcDataSyncClient
    );

    if (!response.LocationArn) {
      throw new Error(
        'DataSync location ARN not found.',
        { cause: 'No ARN returned from server.' }
      );
    }

    output.dataSyncDestLocation = response.LocationArn;
  }
  catch (e) {
    logger.error('Failed to create DataSync destination location.', e);
    return output;
  }

  // prepare transfer task
  logger.debug('Creating DataSync task to initiate S3 object transferring...');
  try {
    let response = await createTask(
      taskName,
      output.dataSyncSrcLocation,
      output.dataSyncDestLocation,
      options.srcCloudWatchLogGroup,
      srcDataSyncClient
    );

    if (!response.TaskArn) {
      throw new Error(
        'DataSync task ARN not found.',
        { cause: 'No ARN returned from server.' }
      );
    }

    output.dataSyncTask = response.TaskArn;
  }
  catch (e) {
    logger.error('Failed to create DataSync task.', e);
    return output;
  }

  // execute transfer task
  logger.debug(`Initiating DataSync transfer between buckets "${srcBucket} and "${destBucket}"...`);
  try {
    let response = await startTask(output.dataSyncTask, srcDataSyncClient);

    if (!response.TaskExecutionArn) {
      throw new Error(
        'DataSync task execution ARN not found.',
        { cause: 'No ARN returned from server.' }
      );
    }

    output.dataSyncTaskExec = response.TaskExecutionArn;
  }
  catch (e) {
    logger.error(`Failed to initate DataSync transfer.`, e);
    return output;
  }

  return output;
}

/**
 * Initiate a DataSync task that copies all S3 objects from source bucket to
 * destination bucket.
 *
 * The source and destination bucket can be in the same AWS accounts, or in
 * different accounts.
 *
 * This operation automatically creates the following resources for you:
 *
 * - 1 S3 bucket in the destination AWS account.
 *
 *   This will be the bucket, whose name is defined in the
 *   `destination.bucketName` argument, where source bucket objects will be
 *   copied to. The destination bucket is assumed to not yet exist, otherwise
 *   the whole operation will abort. In the future, this requirement should not
 *   be mandatory, and you should be able to copy to an existing destination
 *   bucket.
 *
 * - 2 DataSync S3 locations in the source AWS account.
 *
 *   These locations point to the source and destination buckets that DataSync
 *   needs for transferring objects.
 *
 * - 1 DataSync task.
 *
 *   This task is configured to transfer S3 objects between the source and
 *   destination DataSync S3 locations.
 *
 * - 1 DataSync task execution.
 *
 *   This will be a byproduct of executing the DataSync task that will be
 *   created.
 *
 * - 1 CloudWatch log group in the source AWS account, if none exists.
 *
 *   This log group, whose name is defined in the `logGroup` argument, will
 *   be used to put DataSync logs in. If the log group does not exist, then it
 *   will be created.
 *
 * - 1 IAM role in the source AWS account, if none exists.
 *
 *   This IAM role, whose name is defined in the `role` argument, is assumed by
 *   DataSync to perform the copying task. If the role does not exist, then it
 *   will be created with the necessary permissions. But if the role exists,
 *   then it is used instead; so make sure that it already has the necessary
 *   permissions.
 *
 * These resources are created and/or used in the following order:
 * 1. CloudWatch log group
 * 1. IAM role
 * 1. S3 destination bucket
 * 1. DataSync source S3 location
 * 1. DataSync destination S3 location
 * 1. DataSync transfer task, and then
 * 1. DataSync transfer task execution.
 *
 * Information on these resources will then be returned. If a resource creation
 * fails, its resource info will be `null`, and succeeding resource creation
 * ater it will also fail.
 *
 * @param {string} taskName
 * Short, descriptive name to assign to the the DataSync task that will be created.
 *
 * @param {S3BucketLocation} source
 * Details about the bucket to copy from.
 *
 * @param {S3BucketLocation} destination
 * Details about the bucket to copy to.
 *
 * @param {string} role
 * IAM role name in the source AWS account. If it doesn't exist yet, then one
 * will be created first.
 *
 * @param {string} logGroup
 * Log group name to record DataSync logs to.
 *
 * @example
 * <caption>Copy objects from source to destination S3 bucket under the same AWS account.</caption>
 *
 * ```js
 * // prepare your AWS account client credentials
 * const awsAccount = {
 *   region: 'ap-northeast-1',
 *   credentials: {
 *     accessKeyId: 'ABCDEFGHIJKLMNOPQRST',
 *     secretAccessKey: 'WhHGQwvmvDaTne9LnMHV72A4cUkPkZWv2q6ieFtX'
 *   }
 * };
 *
 * await copyBucket(
 *   'My S3 bucket objects clone task',
 *   {
 *     bucketName: 'source-bucket-name', // bucket to copy from
 *     awsConfig: awsAccount // AWS config for S3 service where source bucket is in
 *   },
 *   {
 *     bucketName: 'destination-bucket-name', // bucket to copy to (must not yet exist)
 *     awsConfig: awsAccount // same config for S3 service where destination bucket is in
 *   },
 *   'BucketMigratorRole', // IAM role in source AWS account to assume for DataSync transfer
 *   '/aws/datasync', // CloudWatch log group name in source AWS account to record DataSync logs into
 * );
 *
 * ```
 *
 * @example
 * <caption>Copy objects from source S3 bucket, to destination bucket under a different AWS account.</caption>
 *
 * ```js
 * // prepare your AWS client credentials where the source S3 bucket is in
 * const srcAwsAccount = {
 *   region: 'ap-northeast-1',
 *   credentials: {
 *     accessKeyId: 'ABCDEFGHIJKLMNOPQRST',
 *     secretAccessKey: 'WhHGQwvmvDaTne9LnMHV72A4cUkPkZWv2q6ieFtX'
 *   }
 * };
 *
 * // prepare AWS client credentials where the destination S3 bucket is in
 * const destAwsAccount = {
 *   region: 'ap-northeast-1',
 *   credentials: {
 *     accessKeyId: 'GHIJKLMNOPQRSTUVWXYZ',
 *     secretAccessKey: 'NmakL3ykbA9EuV2Th8JaV425ht4udZRjnjfZpuZN'
 *   }
 * };
 *
 * await copyBucket(
 *   'My cross-account S3 bucket objects clone task',
 *   {
 *     bucketName: 'source-bucket-name',
 *     awsConfig: awsAccount // AWS config for S3 service where source bucket is in
 *   },
 *   {
 *     bucketName: 'destination-bucket-name', // bucket to copy to (must not yet exist)
 *     awsConfig: destAwsAccount // AWS account where the destination bucket is at
 *   },
 *   'BucketMigratorRole', // IAM role in source AWS account to assume for DataSync transfer
 *   '/aws/datasync', // CloudWatch log group name in source AWS account to record DataSync logs into
 * );
 * ```
 *
 * @returns All AWS resources created for the DataSync transfer.
 */
export async function initCopyBucket(taskName, source, destination, role, logGroup) {
  /**
   * @type {DataSyncS3TransferResources}
   */
  const resources = {
    srcAccount: null,
    dataSyncLogGroup: null,
    dataSyncRole: null,
    destBucket: null,
    dataSyncSrc: null,
    dataSyncDest: null,
    dataSyncTask: null,
    dataSyncExec: null
  };

  logger.debug(`Initiating S3 transfer from "${source.bucketName}" to "${destination.bucketName}"...`);

  const destS3 = new S3Client(destination.awsConfig);
  const srcDataSync = new DataSyncClient(source.awsConfig);

  // prepare AWS account info
  logger.debug('Fetching AWS account info...');
  try {
    var srcAccount = await getAwsAccountInfo(source.awsConfig);
  }
  catch (e) {
    logger.error('Failed to fetch AWS account info.', e);
    return resources;
  }
  resources.srcAccount = srcAccount;

  // prepare CloudWatch log group
  logger.debug(`Fetching info on CloudWatch log group "${logGroup}"...`);
  try {
    var dataSyncLogGroup = await getOrCreateLogGroup(logGroup, source.awsConfig);
  }
  catch (e) {
    logger.error(`Failed to fetch log group info".`, e);
    return resources;
  }
  resources.dataSyncLogGroup = dataSyncLogGroup;

  // prepare IAM role
  logger.debug(`Fetching info on IAM role "${role}...`);
  try {
    var dataSyncRole = await getOrCreateDataSyncRole(role, `${srcAccount.Account}`, source.awsConfig);
  }
  catch (e) {
    logger.error(`Failed to fetch IAM role info".`, e);
    return resources;
  }
  resources.dataSyncRole = dataSyncRole;

  // prepare destination bucket
  logger.debug(`Creating destination S3 bucket "${destination.bucketName}"...`);
  try {
    var destBucket = await createBucket(destination.bucketName, destS3);
  }
  catch (e) {
    logger.error(`Failed to create S3 bucket.`, e);
    return resources;
  }
  resources.destBucket = destBucket;

  // update destination bucket policy
  logger.debug(`Updating policy for bucket "${destination.bucketName}...`);
  try {
    await updateDestBucketPolicy(
      destination.bucketName,
      `${srcAccount.Arn}`,
      `${dataSyncRole.Arn}`,
      destS3
    );
  }
  catch (e) {
    logger.error(`Failed to update bucket policy.`, e);
    return resources;
  }

  // create datasync S3 source
  logger.debug(`Creating DataSync S3 location for source bucket "${source.bucketName}"...`);
  try {
    var transferSrc = await createDataSyncLocation(
      `arn:aws:s3:::${source.bucketName}`,
      `${dataSyncRole.Arn}`,
      srcDataSync
    );
  }
  catch (e) {
    logger.error(`Failed to create DataSync source location.`, e);
    return resources;
  }
  resources.dataSyncSrc = transferSrc;

  // create datasync s3 destination
  logger.debug(`Creating DataSync S3 location for destination bucket "${destination.bucketName}"...`);
  try {
    var transferDest = await createDataSyncLocation(
      `arn:aws:s3:::${destination.bucketName}`,
      `${dataSyncRole.Arn}`,
      srcDataSync
    );
  }
  catch (e) {
    logger.error('Failed to create DataSync destination location.', e);
    return resources;
  }
  resources.dataSyncDest = transferDest;

  // prepare transfer task
  logger.debug('Creating DataSync task to initiate S3 object transferring...');
  try {
    var dataSyncTask = await createTask(
      taskName,
      `${transferSrc.LocationArn}`,
      `${transferDest.LocationArn}`,
      `${dataSyncLogGroup.arn}`,
      srcDataSync
    );
  }
  catch (e) {
    logger.error('Failed to create DataSync task.', e);
    return resources;
  }
  resources.dataSyncTask = dataSyncTask;

  // execute transfer task
  logger.debug(`Initiating DataSync transfer between buckets "${source.bucketName} and "${destination.bucketName}"...`);
  try {
    var dataSyncExec = await startTask(`${dataSyncTask.TaskArn}`, srcDataSync);
  }
  catch (e) {
    logger.error(`Failed to initate DataSync transfer.`, e);
    return resources;
  }
  resources.dataSyncExec = dataSyncExec;

  logger.info(`S3 transfer task succesfully initiated, with ARN "${dataSyncExec.TaskExecutionArn}".`);

  return resources;
}