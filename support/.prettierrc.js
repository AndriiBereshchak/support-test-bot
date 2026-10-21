// Same config as every other workspace (copied from exchange/). Without it
// `yarn prettier` in this service falls back to prettier's defaults —
// semicolons and double quotes — and reports every file as unformatted.
module.exports = {
  printWidth: 80,
  tabWidth: 2,
  semi: false,
  singleQuote: true,
  trailingComma: 'es5',
  endOfLine: 'auto',
}
