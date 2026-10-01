import { P2PConfig } from "./P2P";

describe("P2PConfig", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("defaults to disabled transfer and rooms with STUN only", () => {
    const cfg = new P2PConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.roomsEnabled).toBe(false);
    expect(cfg.roomMaxPeers).toBe(8);
    expect(cfg.roomGraceSeconds).toBe(60);
    expect(cfg.sessionTtlMinutes).toBe(30);
    expect(cfg.maxSessionsPerIp).toBe(10);
    expect(cfg.maxMessageBytes).toBe(65536);
    expect(cfg.maxMessagesPerMinute).toBe(600);
    expect(cfg.iceServers()).toEqual([
      { urls: "stun:stun.cloudflare.com:3478" },
    ]);
  });

  it("uses env overrides for ICE and room policy", () => {
    process.env.P2P_ENABLED = "true";
    process.env.P2P_STUN_SERVERS = "stun:a:1,stun:b:2";
    process.env.P2P_TURN_URL = "turn:t:3478";
    process.env.P2P_TURN_USERNAME = "u";
    process.env.P2P_TURN_CREDENTIAL = "c";
    process.env.P2P_ROOM_MAX_PEERS = "3";
    process.env.P2P_ROOM_GRACE_SECONDS = "7";
    process.env.P2P_SESSION_TTL_MINUTES = "12";
    process.env.P2P_MAX_SESSIONS_PER_IP = "4";
    process.env.P2P_MAX_MESSAGE_BYTES = "1024";
    process.env.P2P_MAX_MESSAGES_PER_MINUTE = "15";
    const cfg = new P2PConfig();
    expect(cfg.roomsEnabled).toBe(true);
    expect(cfg.roomMaxPeers).toBe(3);
    expect(cfg.roomGraceSeconds).toBe(7);
    expect(cfg.sessionTtlMinutes).toBe(12);
    expect(cfg.maxSessionsPerIp).toBe(4);
    expect(cfg.maxMessageBytes).toBe(1024);
    expect(cfg.maxMessagesPerMinute).toBe(15);
    expect(cfg.iceServers()).toEqual([
      { urls: "stun:a:1" },
      { urls: "stun:b:2" },
      { urls: "turn:t:3478", username: "u", credential: "c" },
    ]);
  });

  it("can disable rooms independently", () => {
    process.env.P2P_ENABLED = "true";
    process.env.P2P_ROOMS_ENABLED = "false";
    expect(new P2PConfig().roomsEnabled).toBe(false);
  });
});
