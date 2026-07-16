import tseslint from 'typescript-eslint';

export default tseslint.config(...tseslint.configs.recommended, {
  rules: {
    // Project uses single-line ifs without braces — match existing style.
    curly: ['error', 'multi-line'],
    'no-console': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    eqeqeq: ['error', 'always'],
  },
});
