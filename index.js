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
 * Options for DataSync-S3 bucket transfer.
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
 * Build the function that allows you to transfer S3 objects from source to
 * destination buckets via DataSync, on demand.
 * 
 * The necessary AWS service clients are created under the hood which, together
 * with the provided `options`, the returned function uses to perform
 * the DataSync-S3 transfer. These settings are then reused when subsequent
 * bucket transfers are made by calling the same function that was returned.
 * 
 * Note that the provided `srcAwsConfig` must be credentials coming from the AWS
 * account that owns the source buckets. Similarly, `destAwsConfig` must be
 * credentials from the AWS account that owns the destination buckets.
 * 
 * @param {AwsConfig} srcAwsConfig
 * AWS config for the AWS account that owns the source S3 bucket, i.e., where
 * objects will be copied from.
 * 
 * @param {AwsConfig} destAwsConfig
 * AWS config for the AWS account that owns the destination S3 bucket, i.e.,
 * where objects will be copied to.
 * 
 * @param {DataSyncS3TransferOptions} options
 * Additional options for the DataSync-S3 bucket transfer.
 * 
 * @example
 * <caption>Transfer S3 objects from source to destination bucket under the same AWS account.</caption>
 * 
 * ```js
 * // prepare your AWS account client credentials
 * const awsConfig = {
 *   region: 'ap-northeast-1',
 *   credentials: {
 *     accessKeyId: 'ABCDEFGHIJKLMNOPQRST',
 *     secretAccessKey: 'WhHGQwvmvDaTne9LnMHV72A4cUkPkZWv2q6ieFtX'
 *   }
 * };
 * 
 * const execDataSyncS3Transfer = initDataSyncS3Transfer(
 *   awsConfig,
 *   awsConfig,
 *   {
 *     srcDataSyncRole: 'arn:aws:iam::123456789012:role/MyExistingRole',
 *     srcDataSyncPrincipal: '123456789012',
 *     srcCloudWatchLogGroup: 'arn:aws:logs:ap-northeast-1:123456789012:log-group:/aws/datasync:*'
 *   }
 * );
 * ```
 * 
 * @example
 * <caption>Cross-account S3 bucket object transfer.</caption>
 * 
 * ```js
 * // prepare client credentials for your source AWS account "123456789012"
 * const srcAwsConfig = {
 *   region: 'ap-northeast-1',
 *   credentials: {
 *     accessKeyId: 'ABCDEFGHIJKLMNOPQRST',
 *     secretAccessKey: 'WhHGQwvmvDaTne9LnMHV72A4cUkPkZWv2q6ieFtX'
 *   }
 * };
 * 
 * // prepare client credentials for the destination AWS account
 * const destAwsConfig = {
 *   region: 'ap-northeast-1',
 *   credentials: {
 *     accessKeyId: 'GHIJKLMNOPQRSTUVWXYZ',
 *     secretAccessKey: 'BtW2Dy57xmExsCtUALxntVToEHk29bXZuU3TmMv2'
 *   }
 * };
 * 
 * const execDataSyncS3Transfer = initDataSyncS3Transfer(
 *   srcAwsConfig,
 *   destAwsConfig,
 *   {
 *     srcDataSyncRole: 'arn:aws:iam::123456789012:role/MyExistingRole',
 *     srcDataSyncPrincipal: '123456789012',
 *     srcCloudWatchLogGroup: 'arn:aws:logs:ap-northeast-1:123456789012:log-group:/aws/datasync:*'
 *   }
 * );
 * ```
 * 
 * @see {@link execDataSyncS3Transfer} on how to use the returned function to make transfers.
 */
export function initDataSyncS3Transfer(srcAwsConfig, destAwsConfig, options) {
  const srcDataSyncClient = new DataSyncClient(srcAwsConfig);
  const destS3Client = new S3Client(destAwsConfig);

  /**
   * Transfer S3 objects from source to destination bucket, by creating and
   * executing a DataSync task.
   * 
   * Each transfer from source to destination S3 buckt creates the following
   * DataSync resources, in order:
   * 1. DataSync source location, pointing to the source S3 bucket;
   * 1. DataSync destination location, pointing to the destination S3 bucket;
   * 1. DataSync task, with the proper transfer configurations; and
   * 1. DataSync task execution, which is the execution of the created DataSync
   * task.
   * 
   * @param {string} srcBucket
   * Existing S3 bucket name where objects will be copied from.
   *
   * The source bucket must belong to the same AWS account that the
   * `srcDatasyncClient` argument is configured for during the initialization
   * call to {@link initDataSyncS3Transfer}.
   *
   * @param {string} destBucket
   * Non-existent S3 bucket name where objects will be copied to.
   *
   * The destination bucket must belong to the same AWS account that the
   * `destS3Client` argument is configured for during the initialization call to
   * {@link initDataSyncS3Transfer}.
   * 
   * @param {string} taskName
   * name to assign to the DataSync transfer task that will be created and
   * executed.
   * 
   * @returns All DataSync created for the transfer.
   */
  function execDataSyncS3Transfer(srcBucket, destBucket, taskName) {
    return _execDataSyncS3Transfer(taskName, srcBucket, destBucket, options, destS3Client, srcDataSyncClient);
  }
  
  return execDataSyncS3Transfer;
}

/**
 * Create and execute a DataSync task to transfer S3 objects from source to
 * destination bucket.
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
 * Additional options for DataSync-S3 bucket transfer.
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
async function _execDataSyncS3Transfer(taskName, srcBucket, destBucket, options, destS3Client, srcDataSyncClient) {
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