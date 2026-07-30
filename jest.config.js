module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/test"],
  testRegex: ".*\\.(spec|e2e-spec)\\.ts$",
  testTimeout: 15000,
  setupFiles: ["<rootDir>/test/jest.setup.ts"],
  collectCoverageFrom: ["src/**/*.ts", "!src/config/index.ts"],
  moduleNameMapper: {
    // Matches both "src/etc/esm-fix" and the relative "./esm-fix".
    "^(.*/)?esm-fix$": "<rootDir>/test/esm-fix-mock.ts",
    "^src/(.*)$": "<rootDir>/src/$1",
  },
};
