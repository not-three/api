import { $bool, $int, $list, $str } from "./Helper";

export class P2PConfig {
  /** @hidden */
  constructor() {}

  /**
   * Enable P2P signaling.
   * @default false
   * @env P2P_ENABLED
   */
  enabled = $bool("P2P_ENABLED", false);

  /**
   * Enable room sessions. Defaults to the main P2P flag.
   * @default P2P_ENABLED
   * @env P2P_ROOMS_ENABLED
   */
  roomsEnabled = $bool("P2P_ROOMS_ENABLED", this.enabled);

  /**
   * Maximum peers in one room.
   * @default 8
   * @env P2P_ROOM_MAX_PEERS
   */
  roomMaxPeers = $int("P2P_ROOM_MAX_PEERS", 8);

  /**
   * Grace after a room becomes empty, in seconds.
   * @default 60
   * @env P2P_ROOM_GRACE_SECONDS
   */
  roomGraceSeconds = $int("P2P_ROOM_GRACE_SECONDS", 60);

  /**
   * STUN server URLs offered to peers.
   * @default ['stun:stun.cloudflare.com:3478']
   * @env P2P_STUN_SERVERS
   */
  stunServers = $list("P2P_STUN_SERVERS", ["stun:stun.cloudflare.com:3478"]);

  /**
   * Optional external TURN URL.
   * @default ''
   * @env P2P_TURN_URL
   */
  turnUrl = $str("P2P_TURN_URL", "");

  /**
   * TURN username.
   * @default ''
   * @env P2P_TURN_USERNAME
   */
  turnUsername = $str("P2P_TURN_USERNAME", "");

  /**
   * TURN credential.
   * @default ''
   * @env P2P_TURN_CREDENTIAL
   */
  turnCredential = $str("P2P_TURN_CREDENTIAL", "");

  /**
   * Idle session lifetime in minutes.
   * @default 30
   * @env P2P_SESSION_TTL_MINUTES
   */
  sessionTtlMinutes = $int("P2P_SESSION_TTL_MINUTES", 30);

  /**
   * Maximum sessions created by one IP.
   * @default 10
   * @env P2P_MAX_SESSIONS_PER_IP
   */
  maxSessionsPerIp = $int("P2P_MAX_SESSIONS_PER_IP", 10);

  /**
   * Largest accepted signaling frame in bytes.
   * @default 65536
   * @env P2P_MAX_MESSAGE_BYTES
   */
  maxMessageBytes = $int("P2P_MAX_MESSAGE_BYTES", 65536);

  /**
   * Per-socket signaling frames accepted per minute.
   * @default 600
   * @env P2P_MAX_MESSAGES_PER_MINUTE
   */
  maxMessagesPerMinute = $int("P2P_MAX_MESSAGES_PER_MINUTE", 600);

  iceServers(): { urls: string; username?: string; credential?: string }[] {
    const servers: { urls: string; username?: string; credential?: string }[] =
      this.stunServers.map((urls) => ({ urls }));
    if (this.turnUrl)
      servers.push({
        urls: this.turnUrl,
        username: this.turnUsername,
        credential: this.turnCredential,
      });
    return servers;
  }
}
