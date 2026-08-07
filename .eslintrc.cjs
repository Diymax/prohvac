module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',
    'plugin:react-hooks/recommended',
  ],
  // release/ — это копия исходников, подготовленная к выкладке
  // (scripts/build-release.mjs). Линтовать её значит проверять один и тот же
  // код дважды, а заодно спотыкаться на настройках окружения: копия лежит
  // вне дерева, и overrides по путям к ней не применяются.
  ignorePatterns: ['dist', 'release', '.eslintrc.cjs'],
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  settings: { react: { version: '18.2' } },
  plugins: ['react-refresh'],
  rules: {
    'react/jsx-no-target-blank': 'off',
    // В проекте нет ни PropTypes, ни TypeScript — правило давало только шум.
    'react/prop-types': 'off',
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
  },
  overrides: [
    {
      // Конфиги и служебные скрипты исполняются в Node, а не в браузере.
      files: [
        '*.config.js',
        '*.config.cjs',
        'scripts/**/*.mjs',
        'api/**/*.js',
        'server/**/*.js',
        'app.cjs',
      ],
      env: { node: true, browser: false },
    },
  ],
}
