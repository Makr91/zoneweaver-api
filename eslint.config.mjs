import js from '@eslint/js';
import globals from 'globals';
import prettierPlugin from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

export default [
  // Ignore patterns
  {
    ignores: [
      'node_modules/**/*', // Dependencies
      'dist/**/*', // Build output
      'build/**/*', // Build output
      'coverage/**/*', // Test coverage
      '*.min.js', // Minified files
      'packaging/**/*', // Packaging files
      'docs/**/*', // Documentation
      '_sass/**/*', // Jekyll sass files
      'logs/**/*', // Log files
      '**/*.log', // Log files
      'assets/**/*', // Static assets
      '.git/**/*', // Git files
      'scripts/remove-console-taskqueue.js', // Temp script
      'scripts/sync-versions.js',
      'scripts/generate-docs.js',
    ],
  },

  // JavaScript files configuration - Comprehensive Node.js Backend Rules
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2024, // Latest ECMAScript version
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      // Base JavaScript rules (recommended + enhanced)
      ...js.configs.recommended.rules,
      ...prettierConfig.rules,
      'prettier/prettier': 'error',

      // === VARIABLES & DECLARATIONS ===
      'prefer-const': 'error',
      'no-var': 'error',
      'no-undef': 'error',
      'no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'no-use-before-define': ['error', { functions: false, classes: true, variables: true }],
      'no-shadow': 'error',
      'no-shadow-restricted-names': 'error',
      'no-redeclare': 'error',

      // === FUNCTIONS ===
      'func-style': ['error', 'expression', { allowArrowFunctions: true }],
      'prefer-arrow-callback': 'error',
      'arrow-body-style': ['error', 'as-needed'],
      'no-loop-func': 'error',
      'no-new-func': 'error',
      'default-param-last': 'error',
      'no-param-reassign': ['error', { props: false }],

      // === OBJECTS & ARRAYS ===
      'object-shorthand': ['error', 'always'],
      'prefer-destructuring': ['error', { array: true, object: true }],
      'no-array-constructor': 'error',
      'array-callback-return': ['error', { allowImplicit: true }],
      'prefer-spread': 'error',
      'prefer-rest-params': 'error',

      // === STRINGS & TEMPLATES ===
      'prefer-template': 'error',
      'no-useless-escape': 'error',
      'no-useless-concat': 'error',

      // === COMPARISON & CONDITIONALS ===
      eqeqeq: ['error', 'always'],
      'no-nested-ternary': 'warn',
      'no-unneeded-ternary': 'error',
      'no-else-return': 'error',
      'consistent-return': 'error',

      // === ERROR HANDLING ===
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',
      'no-return-await': 'error',

      // === ASYNC/AWAIT & PROMISES ===
      'require-await': 'error',
      'no-await-in-loop': 'warn',
      'no-async-promise-executor': 'error',
      'no-promise-executor-return': 'error',

      // === MODULES ===
      'no-duplicate-imports': 'error',
      'no-useless-rename': 'error',

      // === SECURITY & BEST PRACTICES ===
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-script-url': 'error',
      'no-caller': 'error',
      'no-iterator': 'error',
      'no-proto': 'error',
      'no-extend-native': 'error',
      'no-global-assign': 'error',

      // === NODE.JS SPECIFIC ===
      'no-process-exit': 'off', // Allow process.exit in API server
      'no-process-env': 'off', // Allow process.env in config files
      'no-console': 'warn', // Warn on console usage since we now use Winston

      // === CODE QUALITY ===
      complexity: ['warn', 25], // Increased complexity limit for API endpoints
      'max-depth': ['warn', 6], // Increased nesting depth for API logic
      'max-lines': 'off', // No file length limits for API files
      'max-lines-per-function': ['warn', { max: 200, skipComments: true }], // Larger functions for API endpoints
      'max-params': ['warn', 8], // More parameters for API functions
      'max-statements': ['warn', 50], // More statements for API endpoints

      // === NAMING CONVENTIONS ===
      camelcase: 'off', // Allow snake_case for API parameters (created_by, zone_name, etc.)
      'new-cap': ['error', { newIsCap: true, capIsNew: false }],

      // === PERFORMANCE ===
      'no-lonely-if': 'error',
      'no-useless-call': 'error',
      'no-useless-return': 'error',
      'no-useless-constructor': 'error',

      // === MODERN JAVASCRIPT ===
      'prefer-object-spread': 'error',
      'prefer-exponentiation-operator': 'error',
      'prefer-numeric-literals': 'error',
      'prefer-object-has-own': 'error',

      // === DOCUMENTATION ===
      'valid-jsdoc': 'off', // Deprecated in favor of JSDoc tools
      'require-jsdoc': 'off', // Optional, let developers decide

      // === STYLE (handled by Prettier, but keep logical ones) ===
      curly: ['error', 'all'], // Always use braces
      'dot-notation': 'error',
      'no-multi-assign': 'error',
      'one-var': ['error', 'never'], // One variable declaration per statement

      // === REGEX ===
      'prefer-named-capture-group': 'warn',
      'prefer-regex-literals': 'error',
      'no-useless-backreference': 'error',

      // === IMPORT/EXPORT ===
      'no-restricted-imports': [
        'error',
        {
          patterns: ['../**/node_modules/**'], // Prevent reaching into node_modules
        },
      ],

      // === DEBUGGING ===
      'no-debugger': 'warn', // Allow in development but warn
      'no-alert': 'error', // No alerts in Node.js

      // === UNICODE & SPECIAL CHARACTERS ===
      'unicode-bom': ['error', 'never'],
      'no-irregular-whitespace': 'error',
    },
  },

  // Test files configuration
  {
    files: ['**/*.test.js', '**/*.spec.js', '**/test/**/*.js', '**/tests/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.jest,
        ...globals.mocha,
        ...globals.node,
      },
    },
    rules: {
      // Relax rules for test files
      'no-console': 'off',
      'no-unused-expressions': 'off',
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      'no-magic-numbers': 'off',
      'prefer-arrow-callback': 'off', // Mocha doesn't play well with arrow functions
      'func-style': 'off',
    },
  },

  // Configuration files
  {
    files: ['**/config/**/*.js', '**/*.config.js', '**/*.config.mjs'],
    rules: {
      'no-process-env': 'off', // Allow process.env in config files
      'no-magic-numbers': 'off', // Allow magic numbers in configs
    },
  },

  // Script files (build/utility scripts)
  {
    files: ['scripts/**/*.js'],
    rules: {
      'no-console': 'off', // Allow console in scripts
      'no-process-exit': 'off', // Allow process.exit in scripts
      'func-style': 'off', // Allow function declarations
      'require-await': 'off', // Allow async without await
      'max-statements': 'off', // No statement limits for scripts
      'max-lines-per-function': 'off', // No line limits for script functions
      'max-lines': 'off', // Scripts can be very long
      complexity: 'off', // Scripts can be complex
      'max-params': 'off', // Scripts can have many parameters
      'max-depth': 'off', // Scripts can be deeply nested
      'prefer-destructuring': 'off', // Scripts can use simpler patterns
      'no-magic-numbers': 'off', // Scripts can use magic numbers
    },
  },
];
