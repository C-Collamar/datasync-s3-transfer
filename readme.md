# Problem Statement

- S3 buckets needs to be replicated to the new environment.
- Current data in the existing environment cannot be used in the new environment without replicating S3 buckets.

# Goal

Migrate tenant data from existing environment to anothr environment.

# System Design

[![](https://mermaid.ink/img/pako:eNptkkFvwjAMhf-KlTMIDQaTOGyaxHUnJk1ay8EkLmSkcZW42hDw31caijZoTkn0-eU5zwel2ZCaq8Lxt95iEHhf5B6a9ZCNnI0CkeugCda13pHE0QqGw2cYHzAQoHNghcqY574KrClGMi-nVD9uwaPnI0yyyuodePq5kQPrQbYE54dWuU-FsV5vAlZbMBTFehTLvuMjSV0lbNLqY5bpQCjUQ69WicSWfMyyujL9JFTsrLYUuxLyJm1uLF3cC_eJaMfe-s3fR6dXe68fS1ig4HLvNTjWbeX54woOnSx606N7NZU6nqbDtD3MskwC-lhQAF5_kZYIReCy3-hdd7MU5r_A9hSP8HQJ_5rq3RiogSoplGhNMz2Hs0KumihLytW82RoqsHaSq9yfGhRr4XPnai6hpoFKSSwsNt9aqnmBLja3ZKxweEsT2Q7mQFXoP5k75vQLmsLn2Q?type=png)](https://mermaid.live/edit#pako:eNptkkFvwjAMhf-KlTMIDQaTOGyaxHUnJk1ay8EkLmSkcZW42hDw31caijZoTkn0-eU5zwel2ZCaq8Lxt95iEHhf5B6a9ZCNnI0CkeugCda13pHE0QqGw2cYHzAQoHNghcqY574KrClGMi-nVD9uwaPnI0yyyuodePq5kQPrQbYE54dWuU-FsV5vAlZbMBTFehTLvuMjSV0lbNLqY5bpQCjUQ69WicSWfMyyujL9JFTsrLYUuxLyJm1uLF3cC_eJaMfe-s3fR6dXe68fS1ig4HLvNTjWbeX54woOnSx606N7NZU6nqbDtD3MskwC-lhQAF5_kZYIReCy3-hdd7MU5r_A9hSP8HQJ_5rq3RiogSoplGhNMz2Hs0KumihLytW82RoqsHaSq9yfGhRr4XPnai6hpoFKSSwsNt9aqnmBLja3ZKxweEsT2Q7mQFXoP5k75vQLmsLn2Q)

# Assumptions

There are assumptions made in the making of this project. If any assumptions
are not met, then this package may not work as intended.

- For cross-account bucket transfers, where the source and destination buckets
  belong to different AWS accounts, it is the source AWS account that initiates
  the transfer to the destination account.
- The source AWS config provided, is assumed to be an IAM user who has the
  necessary permissions to perform DataSync-related actions. For more
  information on the required permissions, see [Tutorial: Transferring data from Amazon S3 to Amazon S3 across AWS accounts - AWS DataSync][1].

[1]: https://docs.aws.amazon.com/datasync/latest/userguide/tutorial_s3-s3-cross-account-transfer.html#awsui-tabs-1-9159-user-permissions-2