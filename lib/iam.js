/**
 * @file Exposes API for IAM operations.
 */

import { CreateRoleCommand, GetRoleCommand, IAMClient, NoSuchEntityException, PutRolePolicyCommand } from "@aws-sdk/client-iam";

/**
 * Retrieve the given IAM role by name, or create one first if it does not exist.
 * 
 * If the IAM role already exists, it is assumed to be properly configured for
 * the DataSync transfer.
 * 
 * @param {string} roleName IAM role name.
 * @param {string} accountId ID of the AWS account that can only assume the role.
 * @param {import("@aws-sdk/client-iam").IAMClientConfig} awsConfig IAM client configuration.
 */
export async function getOrCreateDataSyncRole(roleName, accountId, awsConfig) {
  const iam = new IAMClient(awsConfig);
  return await getIamRole(roleName, iam) ?? await createDataSyncIamRole(roleName, accountId, iam);
}

/**
 * Fetch an IAM role by its name.
 * 
 * @param {string} roleName IAM role name.
 * @param {IAMClient} iam IAM service to lookup.
 * @returns IAM role if present, or `null`.
 */
async function getIamRole(roleName, iam) {
  const command = new GetRoleCommand({
    RoleName: roleName
  });

  try {
    var { Role } = await iam.send(command);
  }
  catch (e) {
    if (e instanceof NoSuchEntityException) {
      return null;
    }

    throw e;
  };

  return Role ?? null;
}

/**
 * Create the IAM role that is configured to perform DataSync transfer.
 * 
 * @param {string} roleName IAM role name to create.
 * @param {string} srcAccountId AWS account ID the role will be in.
 * @param {IAMClient} iam IAM service to create the role from.
 * @param {string} srcBucketArn Bucket resources allowed to be read from.
 * @param {string} destBucketArn Bucket resources allowed to be written to.
 * 
 * @see {@link https://docs.aws.amazon.com/datasync/latest/userguide/create-s3-location.html#create-role-manually IAM role setup details}
 */
async function createDataSyncIamRole(roleName, srcAccountId, iam, srcBucketArn = "arn:aws:s3:::*", destBucketArn = "arn:aws:s3:::*") {
  // prepare creation commands for role and policies
  const createRoleCmd = new CreateRoleCommand({
    RoleName: roleName,
    Description: 'Migrate objects between S3 buckets.',
    AssumeRolePolicyDocument: JSON.stringify({
      "Version": "2012-10-17",
      "Statement": [
        {
          "Effect": "Allow",
          "Principal": {
            "Service": "datasync.amazonaws.com"
          },
          "Action": "sts:AssumeRole",
          "Condition": {
            "StringEquals": {
              "aws:SourceAccount": srcAccountId
            },
            "StringLike": {
              "aws:SourceArn": `arn:aws:datasync:ap-northeast-1:${srcAccountId}:*`
            }
          }
        }
      ]
    })
  });

  const putSrcPolicyCmd = new PutRolePolicyCommand({
    PolicyName: 'SourceBucketPermissions',
    RoleName: roleName,
    PolicyDocument: JSON.stringify({
      "Version": "2012-10-17",
      "Statement": [
        {
          "Action": [
            "s3:GetBucketLocation",
            "s3:ListBucket",
            "s3:ListBucketMultipartUploads"
          ],
          "Effect": "Allow",
          "Resource": srcBucketArn
        },
        {
          "Action": [
            "s3:AbortMultipartUpload",
            "s3:DeleteObject",
            "s3:GetObject",
            "s3:ListMultipartUploadParts",
            "s3:GetObjectTagging",
            "s3:PutObjectTagging",
            "s3:PutObject"
          ],
          "Effect": "Allow",
          "Resource": `${srcBucketArn}/*`
        }
      ]
    })
  });

  const putDestPolicyCmd = new PutRolePolicyCommand({
    PolicyName: 'DestinationBucketPermissions',
    RoleName: roleName,
    PolicyDocument: JSON.stringify({
      "Version": "2012-10-17",
      "Statement": [
        {
          "Action": [
            "s3:GetBucketLocation",
            "s3:ListBucket",
            "s3:ListBucketMultipartUploads"
          ],
          "Effect": "Allow",
          "Resource": destBucketArn
        },
        {
          "Action": [
            "s3:AbortMultipartUpload",
            "s3:DeleteObject",
            "s3:GetObject",
            "s3:ListMultipartUploadParts",
            "s3:GetObjectTagging",
            "s3:PutObjectTagging",
            "s3:PutObject"
          ],
          "Effect": "Allow",
          "Resource": `${destBucketArn}/*`
        }
      ]
    })
  });

  // create role
  const { Role } = await iam.send(createRoleCmd);

  if (!Role) {
    const message = 'IAM role for DataSync creation failed.';
    const cause = `The created IAM role "${roleName}" is not found.`;
    throw new Error(message, { cause });
  }

  // attach inline policies
  await Promise.all([
    iam.send(putSrcPolicyCmd),
    iam.send(putDestPolicyCmd)
  ]);

  return Role;
}