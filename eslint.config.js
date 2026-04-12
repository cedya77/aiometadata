const js = require("@eslint/js");
const globals = require("globals");
const reactHooks = require("eslint-plugin-react-hooks");
const reactRefresh = require("eslint-plugin-react-refresh");
const tseslint = require("typescript-eslint");

const ignores = [
  "dist/**",
  "node_modules/**",
  "cache/**",
  "data/**",
  "docs/**",
  "*.txt",
  "*.md",
  "*_proposal.js",
  "*_proposal.ts",
];

const legacyJsRules = {
  "no-unused-vars": "off",
  "prefer-const": "off",
  "no-empty": ["error", { allowEmptyCatch: true }],
};

const relaxedTsRules = {
  "@typescript-eslint/no-explicit-any": "off",
  "@typescript-eslint/no-require-imports": "off",
  "@typescript-eslint/ban-ts-comment": "off",
  "@typescript-eslint/no-empty-object-type": "off",
  "@typescript-eslint/no-unused-vars": "off",
  "prefer-const": "off",
};

module.exports = tseslint.config(
  { ignores },
  {
    files: ["*.{js,cjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: legacyJsRules,
  },
  {
    files: ["*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
    rules: legacyJsRules,
  },
  {
    files: ["addon/**/*.{js,cjs,mjs}", "scripts/**/*.{js,cjs,mjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: legacyJsRules,
  },
  {
    files: ["addon/utils/JSONCrush.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
    rules: legacyJsRules,
  },
  {
    files: ["addon/**/*.{ts,tsx}", "scripts/**/*.{ts,tsx}", "*.{ts,mts,cts}"],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
    rules: {
      ...relaxedTsRules,
    },
  },
  {
    files: ["configure/**/*.{ts,tsx}"],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...relaxedTsRules,
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  }
);
