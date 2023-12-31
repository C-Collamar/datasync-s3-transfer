import { createDataSyncLocation, createTask, startTask } from '#lib/datasync.js';
import { updateBucketPolicy } from '#lib/s3.js';
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
 * @property {'source' | 'destination'} initiatingAccount
 * Indicates whether the source or destination AWS account will be used for
 * creating the necessary DataSync resources, and will be responsible for
 * initiating the S3 object transfer.
 *
 * @property {string} cloudWatchLogGroup
 * ARN of an existing CloudWatch log group, where DataSync logs will be recorded
 * into.
 *
 * The log group must be owned by the initiating AWS account.
 *
 * @property {string} dataSyncPrincipal
 * [AWS principal][1] scoped to the initiating AWS account, to be granted
 * `s3:ListBucket` on the the bucket pressumably not owned by the initiating AWS
 * account.
 *
 * This is useful for finer security control over the latter S3 bucket,
 * [especially for cross-account S3 transfers][2], wherein the source and
 * destination buckets are owned by different AWS accounts. If the buckets
 * belong to the same AWS account, you can simply specify the AWS account ID as
 * principal, or a narrower version involving it (e.g., an existing IAM role).
 *
 * [1]: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_principal.html#Principal_specifying
 * [2]: https://docs.aws.amazon.com/datasync/latest/userguide/tutorial_s3-s3-cross-account-transfer.html#s3-s3-cross-account-update-s3-policy-destination-account
 *
 * @property {string} dataSyncRole
 * ARN of an existing IAM role that DataSync will assume when executing the
 * transfer task.
 *
 * This role must be owned by the initiating AWS account, and must have the
 * [necessary permissions][1] for the transfer task to execute successfully.
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
  const dataSyncClient = new DataSyncClient(
    options.initiatingAccount === 'source'
      ? srcAwsConfig
      : destAwsConfig
  );

  const srcS3Client = new S3Client(srcAwsConfig);
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
   * Existing S3 bucket name where objects will be copied to.
   *
   * The destination bucket must belong to the same AWS account that the
   * `destS3Client` argument is configured for during the initialization call to
   * {@link initDataSyncS3Transfer}.
   * 
   * @param {string} taskName
   * name to assign to the DataSync transfer task that will be created and
   * executed.
   * 
   * @param {Partial<DataSyncS3TransferOutput>} prevState
   * If the call to this function fails for any reason, it likely causes at
   * least one resource, meant to be created for the transfer, to not be
   * created.
   * 
   * In these cases, this function allows you to retry the failed resource
   * creation(s), by feeding onto this parameter the previous output that this
   * function has returned, which contains the AWS resources created so far.
   * When this is done, this function will reuse any created resources instead
   * of creating them, and only create ones that have not been created.
   * 
   * If you pass onto this parameter with all resources created, this function
   * will not create anymore resources, and will only create a new execution of
   * the provided task.
   * 
   * @returns All DataSync created for the transfer.
   */
  function execDataSyncS3Transfer(srcBucket, destBucket, taskName, prevState = {}) {
    return _execDataSyncS3Transfer(taskName, srcBucket, destBucket, options, srcS3Client, destS3Client, dataSyncClient, prevState);
  }
  
  return execDataSyncS3Transfer;
}

/**
 * Check if there is a missing step in making a DataSync transfer, based on the
 * given transfer output.
 * 
 * If there is, an {@link Error} is constructed, containing details as to which
 * step of the transfer process did the transfer started failing.
 * 
 * @param {Partial<DataSyncS3TransferOutput>} transferOutput
 * The transfer output.
 * 
 * @returns An {@link Error} if there is, `null` otherwise.
 */
export function checkIncompleteTransfer(transferOutput) {
  let missing = [];

  if (!transferOutput.dataSyncSrcLocation) {
    missing.push('source location');
  }
  if (!transferOutput.dataSyncDestLocation) {
    missing.push('destination location');
  }
  if (!transferOutput.dataSyncTask) {
    missing.push('task');
  }
  if (!transferOutput.dataSyncTaskExec) {
    missing.push('task execution');
  }

  return missing.length === 0
    ? null
    : new Error(
        'Transfer process is incomplete.',
        { cause: `DataSync resources missing: ${missing.join(', ')}.` }
      );
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
 * Existing S3 bucket name where objects will be copied to.
 *
 * The destination bucket must belong to the same AWS account that the
 * `destS3Client` argument is configured for.
 * 
 * @param {DataSyncS3TransferOptions} options
 * Additional options for DataSync-S3 bucket transfer.
 * 
 * @param {S3Client} srcS3Client
 * Client for the S3 service of the same AWS account that owns the source
 * bucket.
 * 
 * @param {S3Client} destS3Client
 * Client for the S3 service of the same AWS account that owns the destination
 * bucket.
 * 
 * @param {DataSyncClient} dataSyncClient
 * Client for the DataSync service of the initiating AWS account.
   * 
   * @param {Partial<DataSyncS3TransferOutput>} prevState
   * If the call to this function fails for any reason, it likely causes at
   * least one resource, meant to be created for the transfer, to not be
   * created.
   * 
   * In these cases, this function allows you to retry the failed resource
   * creation(s), by feeding onto this parameter the previous output that this
   * function has returned, which contains the AWS resources created so far.
   * When this is done, this function will reuse any created resources instead
   * of creating them, and only create ones that have not been created.
   * 
   * If you pass onto this parameter with all resources created, this function
   * will not create anymore resources, and will only create a new execution of
   * the provided task.
 * 
 * @returns
 * Resources created as byproduct of the DataSync task execution, and a
 * contained exception if there is any during processing.
 */
async function _execDataSyncS3Transfer(taskName, srcBucket, destBucket, options, srcS3Client, destS3Client, dataSyncClient, prevState) {
  /**
   * @type {Partial<DataSyncS3TransferOutput>}.
   */
  const result = {};

  // allow creating datasync location for either source or destination bucket if
  // the bucket is not owned by the initiating aws account
  if (options.initiatingAccount === 'source') {
    try {
      await updateBucketPolicy(
        destBucket,
        options.dataSyncPrincipal,
        options.dataSyncRole,
        destS3Client
      );
    }
    catch (error) {
      return { result, error };
    }
  }
  else {
    try {
      await updateBucketPolicy(
        srcBucket,
        options.dataSyncPrincipal,
        options.dataSyncRole,
        srcS3Client
      );
    }
    catch (error) {
      return { result, error };
    }
  }

  // prepare datasync S3 source
  if (prevState.dataSyncSrcLocation) {
    result.dataSyncSrcLocation = prevState.dataSyncSrcLocation;
  }
  else {
    try {
      let response = await createDataSyncLocation(
        `arn:aws:s3:::${srcBucket}`,
        options.dataSyncRole,
        dataSyncClient
      );
  
      if (!response.LocationArn) {
        throw new Error(
          'DataSync location ARN not found.',
          { cause: 'No ARN returned from server.' }
        );
      }
  
      result.dataSyncSrcLocation = response.LocationArn;
    }
    catch (error) {
      return { result, error };
    }
  }

  // prepare datasync s3 destination
  if (prevState.dataSyncDestLocation) {
    result.dataSyncDestLocation = prevState.dataSyncDestLocation;
  }
  else {
    try {
      let response = await createDataSyncLocation(
        `arn:aws:s3:::${destBucket}`,
        options.dataSyncRole,
        dataSyncClient
      );
  
      if (!response.LocationArn) {
        throw new Error(
          'DataSync location ARN not found.',
          { cause: 'No ARN returned from server.' }
        );
      }
  
      result.dataSyncDestLocation = response.LocationArn;
    }
    catch (error) {
      return { result, error };
    }
  }

  // prepare transfer task
  if (prevState.dataSyncTask) {
    result.dataSyncTask = prevState.dataSyncTask;
  }
  else {
    try {
      let response = await createTask(
        taskName,
        result.dataSyncSrcLocation,
        result.dataSyncDestLocation,
        options.cloudWatchLogGroup,
        dataSyncClient
      );
  
      if (!response.TaskArn) {
        throw new Error(
          'DataSync task ARN not found.',
          { cause: 'No ARN returned from server.' }
        );
      }
  
      result.dataSyncTask = response.TaskArn;
    }
    catch (error) {
      return { result, error };
    }
  }

  // execute transfer task
  try {
    let response = await startTask(result.dataSyncTask, dataSyncClient);

    if (!response.TaskExecutionArn) {
      throw new Error(
        'DataSync task execution ARN not found.',
        { cause: 'No ARN returned from server.' }
      );
    }

    result.dataSyncTaskExec = response.TaskExecutionArn;
  }
  catch (error) {
    return { result, error };
  }

  return { result, error: null };
}