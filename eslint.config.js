// Minimal ESLint flat config layered on top of the strict tsc pass that
// `npm run lint` already runs. tsc owns type errors and unused-code checks;
// ESLint adds the recommended correctness rules on top.
//
// Rules that would fire hundreds of times on the current codebase are turned
// off deliberately rather than half-fixed: `any` appears at real RPC / API
// boundaries where payload shapes are external, and tsc already enforces
// unused locals and parameters.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The compiler-era rules (added in plugin v6) flag existing patterns
      // in App.tsx (initial-load setState-in-effect, inline Date.now() in
      // render). Revisit when App.tsx is split; rules-of-hooks and
      // exhaustive-deps stay on, which is where the real bugs live.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off"
    }
  },
  {
    rules: {
      // External API payloads (Solana RPC, DexScreener, Jupiter, RugCheck)
      // are typed at the edges; interior plumbing still uses `any` widely.
      "@typescript-eslint/no-explicit-any": "off",
      // tsc runs with --noUnusedLocals --noUnusedParameters in the same
      // lint script; keeping the ESLint copy on would double-report.
      "@typescript-eslint/no-unused-vars": "off",
      // `{}` and `Function`-adjacent bans from the recommended set are kept;
      // empty catch/blocks are used for best-effort cleanup paths.
      "no-empty": ["error", { allowEmptyCatch: true }]
    }
  },
  {
    // Node scripts: plain ESM run with `node`, no TypeScript.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        URLSearchParams: "readonly",
        setTimeout: "readonly"
      }
    }
  }
);
