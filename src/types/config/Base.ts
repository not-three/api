import { $bool, $int } from './Helper';
import { DatabaseConfig } from './Database';
import { FileTransferConfig } from './FileTransfer';
import { LimitsConfig } from './Limits';

export class BaseConfig {
  /** @hidden */
  constructor() {}

  /** @hidden */
  database = new DatabaseConfig();

  /** @hidden */
  limits = new LimitsConfig();

  /** @hidden */
  fileTransfer = new FileTransferConfig();

  /**
   * The length of the IDs. Cannot be higher than 32.
   * @default 21
   * @env ID_LENGTH
   */
  idLength = $int('ID_LENGTH', 21);

  /**
   * Child instances do not run migrations. If you have multiple instances running, all but one should be child instances.
   * @default false
   * @env CHILD_INSTANCE
   */
  childInstance = $bool('CHILD_INSTANCE', false);

  /**
   * In the rare case that you need to downgrade the database, set this temporarily to true.
   * Be aware that this can lead to data loss. Make sure to have backups.
   * @default false
   * @env ALLOW_REVERTING_MIGRATIONS
   */
  allowRevertingMigrations = $bool('ALLOW_REVERTING_MIGRATIONS', false);
}
