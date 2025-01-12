import { $bool, $int, $str } from './Helper';

export class FileTransferConfig {
  /** @hidden */
  constructor() {}

  /**
   * Whether file transfer is enabled.
   * @default false
   * @env FILE_TRANSFER_ENABLED
   */
  enabled = $bool('FILE_TRANSFER_ENABLED', false);

  /**
   * The maximum size of a file in MB.
   * @default 10000
   * @env FILE_TRANSFER_MAX_SIZE_MB
   */
  maxSizeInMB = $int('FILE_TRANSFER_MAX_SIZE_MB', 10_000);

  /**
   * The endpoint of the S3-compatible storage.
   * @default 'http://localhost:9000'
   * @env FILE_TRANSFER_S3_ENDPOINT
   */
  s3Endpoint = $str('FILE_TRANSFER_S3_ENDPOINT', 'http://localhost:9000');

  /**
   * The region of the S3-compatible storage.
   * @default 'us-east-1'
   * @env FILE_TRANSFER_S3_REGION
   */
  s3Region = $str('FILE_TRANSFER_S3_REGION', 'us-east-1');

  /**
   * The bucket of the S3-compatible storage.
   *
   * **Note:** We recommend using a bucket with a lifecycle policy that deletes files after a certain time.
   * This way, you can ensure that files are deleted, even if the app fails to do so.
   *
   * @default 'bucket'
   * @env FILE_TRANSFER_S3_BUCKET
   */
  s3Bucket = $str('FILE_TRANSFER_S3_BUCKET', 'bucket');

  /**
   * The access key ID of the S3-compatible storage.
   * @default 'accessKeyId'
   * @env FILE_TRANSFER_S3_ACCESS_KEY_ID
   * @see {@link FileTransferConfig#s3SecretAccessKey}
   */
  s3AccessKeyId = $str('FILE_TRANSFER_S3_ACCESS_KEY_ID', 'accessKeyId');

  /**
   * The secret access key of the S3-compatible storage.
   *
   * We recommend attaching a policy to the user that only allows the following actions:
   *
   * ```json
   * {
   *   "Version": "2012-10-17",
   *   "Statement": [
   *     {
   *       "Effect": "Allow",
   *       "Principal": {
   *         "AWS": "arn:aws:iam::1234:user/my-app"
   *       },
   *       "Action": [
   *         "s3:ListBucket",
   *         "s3:ListBucketVersions"
   *       ],
   *       "Resource": "arn:aws:s3:::my-bucket"
   *     },
   *     {
   *       "Effect": "Allow",
   *       "Principal": {
   *         "AWS": "arn:aws:iam::1234:user/my-app"
   *       },
   *       "Action": [
   *         "s3:PutObject",
   *         "s3:AbortMultipartUpload",
   *         "s3:ListMultipartUploadParts",
   *         "s3:PutObjectAcl",
   *         "s3:DeleteObject",
   *         "s3:DeleteObjectVersion"
   *       ],
   *       "Resource": "arn:aws:s3:::my-bucket/*"
   *     }
   *   ]
   * }
   * ```
   *
   * @default 'secretAccessKey'
   * @env FILE_TRANSFER_S3_SECRET_ACCESS_KEY
   * @see [AWS Policy Generator](https://awspolicygen.s3.amazonaws.com/policygen.html)
   * @see [AWS S3 Policy Examples](https://docs.aws.amazon.com/AmazonS3/latest/userguide/example-policies-s3.html)
   * @see [AWS Create a User](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_users_create.html)
   */
  s3SecretAccessKey = $str(
    'FILE_TRANSFER_S3_SECRET_ACCESS_KEY',
    'secretAccessKey',
  );

  /**
   * The time in minutes after which a file is deleted.
   * @default 15
   * @env FILE_TRANSFER_STORAGE_TIME_MINUTES
   */
  storageTimeInMinutes = $int('FILE_TRANSFER_STORAGE_TIME_MINUTES', 15);

  /**
   * The time in minutes how long a file can be uploaded.
   * This will influence the expiration time of the multipart upload.
   * @default 120
   * @env FILE_TRANSFER_UPLOAD_TIME_MINUTES
   */
  uploadTimeInMinutes = $int('FILE_TRANSFER_UPLOAD_TIME_MINUTES', 120);

  /**
   * The time in minutes between each upload part,
   * before the upload is considered failed/timed out.
   * @default 10
   * @env FILE_TRANSFER_UPLOAD_PART_TIME_MINUTES
   */
  uploadPartTimeInMinutes = $int('FILE_TRANSFER_UPLOAD_PART_TIME_MINUTES', 10);

  /**
   * The maximum amount of files an IP address can upload simultaneously.
   * @default 1
   * @env FILE_TRANSFER_SIMULTANEOUS_FILES_PER_IP
   */
  simultaneousFilesPerIp = $int('FILE_TRANSFER_SIMULTANEOUS_FILES_PER_IP', 1);

  /**
   * The maximum amount of files that can be uploaded simultaneously globally.
   * @default 25
   * @env FILE_TRANSFER_GLOBAL_MAXIMUM_SIMULTANEOUS_FILES
   */
  globalMaximumSimultaneousFiles = $int(
    'FILE_TRANSFER_GLOBAL_MAXIMUM_SIMULTANEOUS_FILES',
    25,
  );
}
