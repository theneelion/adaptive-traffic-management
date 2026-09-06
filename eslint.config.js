import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";

export default [
  {
    // .venv is ai-service's Python virtualenv — it vendors third-party JS (e.g. torch's bundled
    // model-viewer assets) that must never be linted as if it were this repo's own source.
    ignores: [
      "**/dist/**",
      "**/generated/**",
      "**/node_modules/**",
      "**/.venv/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "sessions/**"
    ]
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser }
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules
    }
  },
  {
    // `any` is routine in test-mocking code (typing vi.fn()/fetch mocks precisely adds friction
    // for no real safety benefit here) — kept as an error in production source, where it matters.
    files: ["**/*.test.ts", "**/e2e/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off"
    }
  },
  {
    // Node-run tooling scripts (not part of the TS build): asset generation, atlas packing.
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node
    }
  },
  {
    // k6 load-test scripts run in k6's own JS runtime, not Node or a browser.
    files: ["infra/load/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, __ENV: "readonly" }
    }
  }
];
