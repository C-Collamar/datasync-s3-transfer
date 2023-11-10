/**
 * @file Exposes API for S3-related operations.
 */

import { CreateBucketCommand, PutBucketPolicyCommand, S3Client } from '@aws-sdk/client-s3';

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
 * @param {string} bucketName Name of the bucket clone.
 * @param {string} iamUser IAM user to be allowed bucket clone access.
 * @param {string} iamRole IAM role for DataSync transfer.
 * @param {S3Client} s3 S3 service that owns the given bucket clone.
 * @see {@link https://docs.aws.amazon.com/datasync/latest/userguide/tutorial_s3-s3-cross-account-transfer.html#s3-s3-cross-account-required-permissions-source-account#s3-s3-cross-account-prerequisites Tutorial: Transferring data from Amazon S3 to Amazon S3 across AWS accounts}
 */
export function updateBucketClonePolicy(bucketName, iamUser, iamRole, s3) {
  const updateDestBucketPolicyCmd = new PutBucketPolicyCommand({
    Bucket: bucketName,
    Policy: JSON.stringify({
      Version: '2008-10-17',
      Statement: [
        {
          Sid: 'DataSyncCreateS3LocationAndTaskAccess',
          Effect: 'Allow',
          Principal: {
            AWS: iamRole
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
            AWS: iamUser
          },
          Action: 's3:ListBucket',
          Resource: `arn:aws:s3:::${bucketName}`
        }
      ]
    })
  });
  return s3.send(updateDestBucketPolicyCmd);
}