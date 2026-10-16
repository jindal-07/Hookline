import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["**/node_modules/**", "**/dist/**", "coverage/**", ".pg-test/**", "tests/.tmp/**", "server/storage/**"] },
  js.configs.recommended,
  {
    files: ["server/**/*.js", "shared/**/*.js", "tests/**/*.js", "*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node } },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  {
    files: ["client/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2024, sourceType: "module", globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // JSX identifiers are not tracked without the react plugin
      "no-unused-vars": ["error", { varsIgnorePattern: "^[A-Z_]|^motion$", argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
];
