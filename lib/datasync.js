/**
 * @file Exposes API for DataSync operations.
 */

import { CreateLocationS3Command, CreateTaskCommand, DataSyncClient, PreserveDeletedFiles, StartTaskExecutionCommand } from '@aws-sdk/client-datasync';

/**
 * Create a DataSync S3 location.
 *
 * @param {string} bucketArn
 * ARN of the S3 bucket to represent as DataSync location.
 *
 * @param {string} roleArn
 * ARN of the IAM role with access to the given bucket. See [Creating an IAM role for DataSync to access your S3 bucket][1].
 *
 * @param {DataSyncClient} datasync
 * DataSync service to create the location in.
 * 
 * [1]: https://docs.aws.amazon.com/datasync/latest/userguide/create-s3-location.html#create-role-manually
 */
function createDataSyncLocation(bucketArn, roleArn, datasync) {
  const createDataSyncSrcCmd = new CreateLocationS3Command({
    S3BucketArn: bucketArn,
    S3Config: {
      BucketAccessRoleArn: roleArn
    }
  });
  
  return datasync.send(createDataSyncSrcCmd);
}

/**
 * AWS DataSync resources involved in a S3 cloning operation.
 * @typedef DataSyncResources
 * @property {import('@aws-sdk/client-datasync').CreateLocationS3CommandOutput} transferSrc Source S3 location ARN.
 * @property {import('@aws-sdk/client-datasync').CreateLocationS3CommandOutput} transferDest Destination S3 location ARN.
 * @property {import('@aws-sdk/client-datasync').CreateTaskCommandOutput} transferTask Clone task ARN.
 * @property {import('@aws-sdk/client-datasync').StartTaskExecutionCommandOutput} transferExec Task execution ARN.
 */

/**
 * Initiate a DataSync task to copy S3 objects from source to destination S3 buckets.
 * 
 * The given role must have access to both the source and destination S3 buckets to
 * clone successfully. Transfer events can be monitored via the given CloudWatch log
 * group.
 * 
 * @param {string} taskName Name of the DataSync task that will be created.
 * @param {string} srcBucket Source bucket name.
 * @param {string} destBucket Destination bucket ARN.
 * @param {string} roleArn IAM role ARN allowed to perform DataSync transfer.
 * @param {string} logGroupArn CloudWatch log group ARN used to monitor the transfer.
 * @param {import('@aws-sdk/client-datasync').DataSyncClientConfig} awsConfig DataSync client configuration.
 */
export async function startDataSyncTransfer(taskName, srcBucket, destBucket, roleArn, logGroupArn, awsConfig) {
  const datasync = new DataSyncClient(awsConfig);
  
  // create datasync S3 source
  const transferSrc = await createDataSyncLocation(
    `arn:aws:s3:::${srcBucket}`,
    roleArn,
    datasync
  );

  // create datasync s3 destination
  const transferDest = await createDataSyncLocation(
    `arn:aws:s3:::${destBucket}`,
    roleArn,
    datasync
  );

  // prepare transfer
  const createCloneTaskCmd = new CreateTaskCommand({
    Name: taskName,
    SourceLocationArn: transferSrc.LocationArn,
    DestinationLocationArn: transferDest.LocationArn,
    CloudWatchLogGroupArn: logGroupArn,
    Options: {
      PreserveDeletedFiles: PreserveDeletedFiles.REMOVE
    }
  });
  const transferTask = await datasync.send(createCloneTaskCmd);

  // start transfer
  const startCloneTaskCmd = new StartTaskExecutionCommand({
    TaskArn: transferTask.TaskArn
  });

  const transferExec = await datasync.send(startCloneTaskCmd);

  /**
   * @type {DataSyncResources}
   */
  const resources = {
    transferSrc,
    transferDest,
    transferTask,
    transferExec
  };

  return resources;
}