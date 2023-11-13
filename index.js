import { getOrCreateLogGroup } from '#lib/cloudwatch.js';
import { startDataSyncTransfer } from '#lib/datasync.js';
import { getOrCreateDataSyncRole } from '#lib/iam.js';
import { logger } from '#lib/logger.js';
import { createBucket, updateBucketClonePolicy } from '#lib/s3.js';
import { getAwsAccountInfo } from '#lib/sts.js';
import { S3Client } from '@aws-sdk/client-s3';

/**
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
 */
export async function initCopyBucket(taskName, source, destination, role, logGroup) {
  logger.debug(`Initiating S3 transfer from "${source.bucketName}" to "${destination.bucketName}"...`);
  
  const destS3 = new S3Client(destination.awsConfig);

  // prepare AWS account info
  logger.debug('Fetching AWS account info...');
  try {
    var srcAccount = await getAwsAccountInfo(source.awsConfig);
  }
  catch (e) {
    logger.error('Failed to fetch AWS account info.', e);
    throw e;
  }

  const { Arn: dataSyncUserArn, Account: accountId } = srcAccount;

  // prepare CloudWatch log group
  logger.debug(`Fetching info on CloudWatch log group "${logGroup}"...`);
  try {
    var dataSyncLogGroup = await getOrCreateLogGroup(logGroup, source.awsConfig);
  }
  catch (e) {
    logger.error(`Failed to fetch log group info".`, e);
    throw e;
  }
  
  // prepare IAM role
  logger.debug(`Fetching info on IAM role "${role}...`);
  try {
    var dataSyncRole = await getOrCreateDataSyncRole(role, `${accountId}`, source.awsConfig);
  }
  catch (e) {
    logger.error(`Failed to fetch IAM role info".`, e);
    throw e;
  }

  // prepare destination bucket
  logger.debug(`Creating destination S3 bucket "${destination.bucketName}"...`);
  try {
    var destBucket = await createBucket(destination.bucketName, destS3);
  }
  catch (e) {
    logger.error(`Failed to create S3 bucket.`, e);
    throw e;
  }

  // update destination bucket policy
  logger.debug(`Updating policy for bucket "${destination.bucketName}...`);
  try {
    await updateBucketClonePolicy(
      destination.bucketName,
      `${dataSyncUserArn}`,
      `${dataSyncRole.Arn}`,
      destS3
    );
  }
  catch (e) {
    logger.error(`Failed to update bucket policy.`, e);
    throw e;
  }

  // copy S3 objects from source to destination bucket
  logger.debug(`Initiating DataSync transfer between buckets "${source.bucketName} and "${destination.bucketName}"...`);
  try {
    var dataSyncResources = await startDataSyncTransfer(
      taskName,
      source.bucketName,
      destination.bucketName,
      `${dataSyncRole.Arn}`,
      `${dataSyncLogGroup.arn}`,
      source.awsConfig
    );
  }
  catch (e) {
    logger.error(`Failed to initate DataSync transfer.`, e);
    throw e;
  }

  const allResources = {
    destBucket,
    ...dataSyncResources
  };

  logger.info('S3 transfer succesfully initiated.', dataSyncResources.transferExec);

  return allResources;
}