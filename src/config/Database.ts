import { $bool, $int, $oneOf, $str } from './Helper';

export class DatabaseConfig {
  /** @hidden */
  constructor() {}

  /**
   * The mode of the database.
   * @default 'sqlite3'
   * @values 'sqlite3', 'pg', 'mysql'
   * @env DATABASE_MODE
   */
  mode = $oneOf('DATABASE_MODE', ['sqlite3', 'pg', 'mysql'], 'sqlite3');

  /**
   * The host of the database. Not used for SQLite.
   * @default 'localhost'
   * @env DATABASE_HOST
   */
  host = $str('DATABASE_HOST', 'localhost');

  /**
   * The port of the database. Not used for SQLite.
   * @default 5432
   * @env DATABASE_PORT
   */
  port = $int('DATABASE_PORT', 5432);

  /**
   * The username of the database. Not used for SQLite.
   * @default 'username'
   * @env DATABASE_USERNAME
   */
  user = $str('DATABASE_USERNAME', 'username');

  /**
   * The password of the database. Not used for SQLite.
   * @default 'password'
   * @env DATABASE_PASSWORD
   */
  password = $str('DATABASE_PASSWORD', 'password');

  /**
   * The filename of the SQLite database. Only used for SQLite.
   * @default 'db/database.sqlite'
   * @env DATABASE_FILE
   */
  filename = $str('DATABASE_FILE', 'db/database.sqlite');

  /**
   * The name of the database. Not used for SQLite.
   * @default 'database'
   * @env DATABASE_NAME
   */
  database = $str('DATABASE_NAME', 'database');

  /**
   * In the rare case that you need to downgrade the database, set this temporarily to true.
   * Be aware that this can lead to data loss. Make sure to have backups.
   * @default false
   * @env ALLOW_REVERTING_MIGRATIONS
   */
  allowRevertingMigrations = $bool('ALLOW_REVERTING_MIGRATIONS', false);
}
