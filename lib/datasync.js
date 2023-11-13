/**
 * @file Exposes API for DataSync operations.
 */

import { CreateLocationS3Command, CreateTaskCommand, DataSyncClient, LogLevel, PreserveDeletedFiles, StartTaskExecutionCommand } from '@aws-sdk/client-datasync';

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
export function createDataSyncLocation(bucketArn, roleArn, datasync) {
  const createDataSyncSrcCmd = new CreateLocationS3Command({
    S3BucketArn: bucketArn,
    S3Config: {
      BucketAccessRoleArn: roleArn
    }
  });
  
  return datasync.send(createDataSyncSrcCmd);
}

/**
 * Create a DataSync task for transferring data from source to destination S3
 * location, with basic logging enabled.
 * 
 * @param {string} taskName Task name.
 * @param {string} srcLocArn DataSync source location ARN.
 * @param {string} destLocArn DataSync destination location ARN.
 * @param {string} logGroupArn CloudWatch log group to log task execution.
 * @param {DataSyncClient} dataSync DataSync client.
 */
export function createTask(taskName, srcLocArn, destLocArn, logGroupArn, dataSync) {
  const command = new CreateTaskCommand({
    Name: taskName,
    SourceLocationArn: srcLocArn,
    DestinationLocationArn: destLocArn,
    CloudWatchLogGroupArn: logGroupArn,
    Options: {
      PreserveDeletedFiles: PreserveDeletedFiles.REMOVE,
      LogLevel: LogLevel.BASIC
    }
  });

  return dataSync.send(command);
}

/**
 * Execute the given task by ARN.
 * 
 * @param {string} taskArn DataSync task ARN to execute.
 * @param {DataSyncClient} dataSync DataSync client.
 */
export function startTask(taskArn, dataSync) {
  const command = new StartTaskExecutionCommand({
    TaskArn: taskArn
  });

  return dataSync.send(command);
}