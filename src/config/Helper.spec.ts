import { $bool, $int, $list, $oneOf, $str } from "./Helper";

describe("config helpers", () => {
  afterEach(() => {
    delete process.env.TEST_HELPER_VAR;
  });

  it("returns the default when the env var is unset", () => {
    expect($str("TEST_HELPER_VAR", "fallback")).toBe("fallback");
    expect($int("TEST_HELPER_VAR", 42)).toBe(42);
    expect($bool("TEST_HELPER_VAR", true)).toBe(true);
    expect($list("TEST_HELPER_VAR", ["a", "b"])).toEqual(["a", "b"]);
  });

  it("throws when a required env var is missing", () => {
    expect(() => $str("TEST_HELPER_VAR")).toThrow(
      "Missing environment variable: TEST_HELPER_VAR",
    );
  });

  it("reads and parses values from the environment", () => {
    process.env.TEST_HELPER_VAR = "7";
    expect($int("TEST_HELPER_VAR", 42)).toBe(7);
    process.env.TEST_HELPER_VAR = "TRUE";
    expect($bool("TEST_HELPER_VAR", false)).toBe(true);
  });

  it("$oneOf accepts listed values and rejects others", () => {
    process.env.TEST_HELPER_VAR = "b";
    expect($oneOf("TEST_HELPER_VAR", ["a", "b"], "a")).toBe("b");
    process.env.TEST_HELPER_VAR = "c";
    expect(() => $oneOf("TEST_HELPER_VAR", ["a", "b"], "a")).toThrow(
      "Invalid value for environment variable: TEST_HELPER_VAR",
    );
  });
});
