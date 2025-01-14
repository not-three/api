import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from './config.service';
import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from './database.service';

@Injectable()
export class S3Service implements OnModuleInit {
  private readonly logger = new Logger(S3Service.name);
  private client: S3Client | null = null;
  private bucket = 'files';

  constructor(
    private readonly cfg: ConfigService,
    private readonly db: DatabaseService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  onModuleInit() {
    const cfg = this.cfg.get().fileTransfer;
    if (!cfg.enabled) return;
    this.bucket = cfg.s3Bucket;
    this.client = new S3Client({
      endpoint: cfg.s3Endpoint,
      region: cfg.s3Region,
      credentials: {
        accessKeyId: cfg.s3AccessKeyId,
        secretAccessKey: cfg.s3SecretAccessKey,
      },
    });
  }

  private getClient() {
    if (!this.client) throw new Error('S3 client not initialized');
    return this.client;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.getClient().send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      this.logger.debug(`File ${key} exists`);
      return true;
    } catch {
      this.logger.debug(`File ${key} does not exist`);
      return false;
    }
  }

  async createDownloadUrl(key: string): Promise<string> {
    const cache = await this.cache.get<string>(`downloadUrl:${key}`);
    if (cache) return cache;
    const url = await getSignedUrl(
      this.getClient(),
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
      { expiresIn: 3600 },
    );
    this.logger.debug(`Created download URL for ${key}`);
    this.cache.set(`downloadUrl:${key}`, url, 3300_000);
    return url;
  }

  async delete(key: string): Promise<void> {
    await this.getClient().send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    this.logger.log(`Deleted file ${key}`);
  }

  async startMultipartUpload(key: string, expires: Date): Promise<string> {
    const upload = await this.getClient().send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        Expires: expires,
      }),
    );
    this.logger.log(`Created multipart upload for ${key}`);
    return upload.UploadId;
  }

  async createUploadPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    contentLength: number,
  ): Promise<string> {
    const res = await getSignedUrl(
      this.getClient(),
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: contentLength,
      }),
      { expiresIn: 60 },
    );
    this.logger.debug(`Created upload URL for part ${partNumber} of ${key}`);
    return res;
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.getClient().send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
    this.logger.debug(`Aborted multipart upload for ${key}`);
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    etags: string[],
  ): Promise<void> {
    await this.getClient().send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: etags.map((etag, i) => ({
            ETag: etag,
            PartNumber: i + 1,
          })),
        },
      }),
    );
    this.logger.log(`Completed multipart upload for ${key}`);
  }

  @Cron('30 * * * * *')
  async cleanUp() {
    if (!this.client) return;
    const cfg = this.cfg.get();
    if (cfg.childInstance) return;
    this.logger.debug('Running cleanup cron job');
    let aborted = 0;
    let deleted = 0;
    for (const file of await this.db.getUploadFilesLastUpdatedBefore(
      Date.now() - cfg.fileTransfer.uploadPartTimeInMinutes * 60_000,
    )) {
      const key = `${file.id}/${file.name}`;
      await this.abortMultipartUpload(key, file.upload_id);
      await this.db.deleteFile(file.id);
      aborted++;
    }
    for (const file of await this.db.getExpiredFiles()) {
      const key = `${file.id}/${file.name}`;
      if (file.upload_id) {
        await this.abortMultipartUpload(key, file.upload_id);
        aborted++;
      } else {
        await this.delete(key);
        deleted++;
      }
      await this.db.deleteFile(file.id);
    }
    if (aborted) this.logger.log(`Aborted ${aborted} expired uploads`);
    if (deleted) this.logger.log(`Deleted ${deleted} expired files`);
    this.logger.debug(
      `Finished cleanup cron job, cleaned up ${aborted + deleted} files`,
    );
  }
}
