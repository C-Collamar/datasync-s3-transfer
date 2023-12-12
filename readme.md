# DataSync S3 Transfer
Automate S3 object transfers between buckets via DataSync!

> 🚧 This guide is under construction. 🚧

## Use Case

- Transfer S3 objects between AWS S3 buckets via DataSync, without having to click around the AWS Console.
- S3 transfer can be between buckets in the same AWS accounts, or across different accounts.
- The necessary DataSync resources are generated for you, so you you don't have to.
- Create automation scripts using this tool, to initiate batch S3 object transfers between many buckets.

## Usage

1. Prepare inputs.

   ```js
   // source aws profile to the aws account where your source bucket is in
   const srcAwsProfile = {
     region: 'ap-northeast-1',
     credentials: {
       accessKeyId: 'ABCDEFGHIJKLMNOPQRST',
       secretAccessKey: 'WhHGQwvmvDaTne9LnMHV72A4cUkPkZWv2q6ieFtX'
     }
   };
   
   // if source and destination buckets belong to the same aws account, then...
   const destAwsProfile = srcAwsProfile;
   
   const dataSyncOptions = {
     // source aws account id, where your source bucket is in
     srcDataSyncPrincipal: '123456789012',
   
     // source iam role, with access to the source and destination buckets (see notes on permissions)
     srcDataSyncRole: 'arn:aws:iam::123456789012:role/MyExistingRole',
   
     // source cloudwatch log group, where datasync will record logs into
     srcCloudWatchLogGroup: 'arn:aws:logs:ap-northeast-1:123456789012:log-group:/aws/datasync:*'
   };
   ```

   Notes:

   - If you want to do cross-account S3 object transfers, i.e., where the destination bucket is owned by a different AWS account than the source bucket, then set a different profile for `destAwsProfile` similar to `srcAwsProfile`.

   - The IAM role specified in `dataSyncoptions.srcDataSyncRole` must have the necessary permissions for DataSync to assume. See [IAM Role Permissions](#iam-role-permissions) on how the role must be setup.
   

1. Start the transfer. That's it!
   ```js
   import { initDataSyncS3Transfer } from "datasync-s3-transfer";

   // configure transfer settings
   const transfer = initDataSyncS3Transfer(srcAwsConfig, destAwsConfig, dataSyncOptions);
   
   // start the transfer
   await transfer(
     'source-bucket',              // existing source bucket name
     'destination-bucket',         // existing destination bucket name
     'Transfer to my other bucket' // the name of this transfer
   );
   ```

   After the call to `transfer()` has been made, source S3 objects will be copied to the destination bucket the after some time. See under the hood on [How A Transfer Is Made](#how-a-transfer-is-made).

1. Multiple transfers? Yes we can!

   ```js
   // initialize once
   const transfer = initDataSyncS3Transfer(srcAwsConfig, destAwsConfig, dataSyncOptions);
   
   const toTransfer = [
     { from: 'source-bucket-1', to: 'destination-bucket-1', name: 'Transfer task 1' },
     { from: 'source-bucket-2', to: 'destination-bucket-2', name: 'Transfer task 2' },
     // ...etc
   ];
   
   // transfer multiple times
   for (const item of toTransfer) {
     await transfer(item.from, item.to, item.name);
   }
   
   // or if you want to initiate the transfers concurrently...
   await Promise.all(
     toTransfer.map((item) => transfer(item.from, item.to, item.name))
   );
   ```

1. How to properly handle errors? See [Error Handling and Retries](#error-handling-and-retries) for details.

## How a Transfer is Made

Each time a transfer is made using this tool, the following AWS resources are created under the same AWS account that owns the source S3 bucket, in order:

1. DataSync source S3 location, pointing to the source S3 bucket.
1. DataSync destination S3 location, pointing to the destination S3 bucket.
1. DataSync task with a fixed configuration (e.g., basic logging enabled), used to initiate a transfer.
1. DataSync task execution, which is the byproduct of executing the created DataSync task.

Information on these created resources are then returned from the transfer call, in the `result` variable as seen below.

```js
// start the transfer
const { result, error } = await transfer('source-bucket', 'destination-bucket', 'Transfer to my other bucket');
```

## Error Handling and Retries

Errors can happen at any point during the transfer process, from network issues all the way up to misconfigurations on your part. In any case, you can check for errors via the `error` property returned by the transfer call.

```js
const { result, error } = await transfer('source-bucket', 'destination-bucket', 'Transfer to my other bucket');

if (error) {
  console.error(error);
}
else {
  console.info('Transfer success!');
}
```

### Retrying a Failed Transfer

Understanding [How a Transfer is Made](#how-a-transfer-is-made), it is possible for an unexpected error (e.g., network or system error) to arise during any of the AWS resource-creation step. This can cause the transfer to become incomplete, where some of the necessary AWS resources have already been created, while the rest have not yet.

In this case, you can retry the transfer as follows:

```js
let transferState = await transfer('source-bucket', 'destination-bucket', 'Transfer to my other bucket');

// retry on error
while (transferState.error) {
  console.error(transferState.error);
  console.info('Retrying...');

  // you can also make retry optional by prompting retry confirmation first before executing this retry statement below
  transferState = await transfer('source-bucket', 'destination-bucket', 'Transfer to my other bucket', transferState.result);
}

// you can also retry despite script termination by exporting transferState.result, to a file for example
```

This way, successfully created AWS resources will be reused when retrying the transfer. Without supplying the `transferState.result` argument in the example above, calling `transfer()` mutiple times will create a new set of resources, which will likely cause AWS to complain about resource duplication.

## System Design

```mermaid
flowchart TD
    start(((Start)))
    in[/Source and destination buckets,\nAWS creds, DataSync options, etc./]
    policy[[Update destination\nbucket policy]]
    srcloc[[Create DataSync\nsource S3 location]]
    destloc[[Create DataSync\ndestination S3 location]]
    task[[Create DataSync\ntransfer task]]
    exec[[Execute\ntransfer task]]
    out[/DataSync source S3 location,\nDataSync destination S3 location,\nDataSync task,\nDataSync task execution/]
    stop(((Stop)))

    start -- input --> in
    in --> policy
    in --> srcloc
    in --> destloc
    srcloc --> task
    destloc --> task
    policy --> destloc
    task --> exec
    exec -- output --> out
    out --> stop
```

## Design Choices and Assumptions

Assumptions has to be made in making this project. If any assumptions
are not met, then this tool may not work prooperly.

- For cross-account bucket transfers, the transfer is initiated and managed from the source AWS account, rather than from the destination account.
- The source AWS config provided is assumed to be an IAM user who has the
  necessary permissions to perform DataSync-related actions. For more
  information on the required permissions, see [Tutorial: Transferring data from Amazon S3 to Amazon S3 across AWS accounts - AWS DataSync][1].

### IAM Role Permissions

The IAM role, whose ARN is passed in the `srcDataSyncRole` DataSync initialization option, must have the necessaary permissions as shown in the following policy document:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": [
        "s3:GetBucketLocation",
        "s3:ListBucket",
        "s3:ListBucketMultipartUploads"
      ],
      "Effect": "Allow",
      "Resource": "arn:aws:s3:::*"
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
      "Resource": "arn:aws:s3:::*/*"
    }
  ]
}
```

The idea is to allow certain actions on S3 objects that belong to the source and destination buckets. And by scoping the `Resource` properties as such, you can initiate S3 object transfers from _any_ buckets in the source AWS accuont, to _any_ buckets in the destination AWS account.

That being said, you can limit the scope of the `Resource` policy elements by explicitly listing the source and destination buckets only. Just keep in mind that S3 object transfers will not work if neither the source nor destination bucket is not included in this scope.

[1]: https://docs.aws.amazon.com/datasync/latest/userguide/tutorial_s3-s3-cross-account-transfer.html#awsui-tabs-1-9159-user-permissions-2
[2]: https://repost.aws/knowledge-center/s3-large-transfer-between-buckets