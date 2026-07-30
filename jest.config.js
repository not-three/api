module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/test"],
  testRegex: ".*\\.(spec|e2e-spec)\\.ts$",
  testTimeout: 15000,
  collectCoverageFrom: ["src/**/*.ts", "!src/config/index.ts"],
  moduleNameMapper: {
    "^src/etc/esm-fix$": "<rootDir>/test/esm-fix-mock.ts",
    "^src/(.*)$": "<rootDir>/src/$1",
  },
};
