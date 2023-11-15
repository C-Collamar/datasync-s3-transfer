/**
 * @file Exposes API for S3-related operations.
 */

import { CreateBucketCommand, GetBucketPolicyCommand, PutBucketPolicyCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Create an S3 bucket.
 * 
 * @param {string} destBucketName Bucket name.
 * @param {S3Client} s3 S3 service client to create bucket in.
 * @returns Name of the tenant S3 bucket clone.
 */
export async function createBucket(destBucketName, s3) {
  const createDestBucketCmd = new CreateBucketCommand({ Bucket: destBucketName });
  return s3.send(createDestBucketCmd);
}

/**
 * Grant the given IAM user and role the required permissions over
 * the given S3 bucket, to perform DataSync data migration.
 * 
 * @param {string} bucketName Name of the bucket.
 * @param {string} principal AWS principal to be allowed `s3:ListBucket` on the bucket.
 * @param {string} roleArn IAM role ARN for DataSync transfer.
 * @param {S3Client} s3 S3 service that owns the given bucket clone.
 * @see {@link https://docs.aws.amazon.com/datasync/latest/userguide/tutorial_s3-s3-cross-account-transfer.html#s3-s3-cross-account-required-permissions-source-account#s3-s3-cross-account-prerequisites Tutorial: Transferring data from Amazon S3 to Amazon S3 across AWS accounts}
 */
export async function updateDestBucketPolicy(bucketName, principal, roleArn, s3) {
  const getCurrPolicyCmd = new GetBucketPolicyCommand({
    Bucket: bucketName
  });

  /**
   * @type {{ Version: string, Statement: unknown[] }}
   */
  let bucketPolicy = {
    Version: '2008-10-17',
    Statement: []
  };

  try {
    let { Policy } = await s3.send(getCurrPolicyCmd);

    if(Policy) {
      bucketPolicy = JSON.parse(Policy)
    }
  }
  catch (e) {
    // failed to get policy of bucket ${bucketName}. No policy is assumed to be present
  }

  bucketPolicy.Statement.push(
    {
      Sid: 'DataSyncCreateS3LocationAndTaskAccess',
      Effect: 'Allow',
      Principal: {
        AWS: roleArn
      },
      Action: [
        's3:GetBucketLocation',
        's3:ListBucket',
        's3:ListBucketMultipartUploads',
        's3:AbortMultipartUpload',
        's3:DeleteObject',
        's3:GetObject',
        's3:ListMultipartUploadParts',
        's3:PutObject',
        's3:GetObjectTagging',
        's3:PutObjectTagging'
      ],
      Resource: [
        `arn:aws:s3:::${bucketName}`,
        `arn:aws:s3:::${bucketName}/*`
      ]
    },
    {
      Sid: 'DataSyncCreateS3Location',
      Effect: 'Allow',
      Principal: {
        AWS: principal
      },
      Action: 's3:ListBucket',
      Resource: `arn:aws:s3:::${bucketName}`
    }
  );
  
  const updateDestBucketPolicyCmd = new PutBucketPolicyCommand({
    Bucket: bucketName,
    Policy: JSON.stringify(bucketPolicy)
  });

  return s3.send(updateDestBucketPolicyCmd);
}