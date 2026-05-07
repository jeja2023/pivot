const nodeGlobals = {
    Buffer: 'readonly',
    URL: 'readonly',
    __dirname: 'readonly',
    __filename: 'readonly',
    clearInterval: 'readonly',
    clearTimeout: 'readonly',
    console: 'readonly',
    exports: 'readonly',
    module: 'readonly',
    process: 'readonly',
    require: 'readonly',
    setInterval: 'readonly',
    setTimeout: 'readonly'
};

const browserGlobals = {
    Blob: 'readonly',
    DOMPurify: 'readonly',
    FileReader: 'readonly',
    FormData: 'readonly',
    Headers: 'readonly',
    TextDecoder: 'readonly',
    URL: 'readonly',
    alert: 'readonly',
    caches: 'readonly',
    clearTimeout: 'readonly',
    confirm: 'readonly',
    console: 'readonly',
    document: 'readonly',
    fetch: 'readonly',
    hljs: 'readonly',
    katex: 'readonly',
    localStorage: 'readonly',
    location: 'readonly',
    marked: 'readonly',
    navigator: 'readonly',
    self: 'readonly',
    setTimeout: 'readonly',
    window: 'readonly'
};

module.exports = [
    {
        ignores: [
            'node_modules/**',
            'data/**',
            'logs/**',
            'uploads/**',
            'client/common/vendor/**'
        ]
    },
    {
        files: ['server/**/*.js', 'scripts/**/*.js', 'tests/**/*.js', 'eslint.config.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: nodeGlobals
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                caughtErrors: 'none',
                varsIgnorePattern: '^_'
            }]
        }
    },
    {
        files: ['client/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: browserGlobals
        },
        rules: {
            'no-undef': 'off',
            'no-unused-vars': 'off'
        }
    }
];
