import * as ModuleAlias from 'module-alias'

// Runtime twin of tsconfig `paths`. Both must be edited together — tsc only
// rewrites types, not the emitted `require()` calls.
ModuleAlias.addAliases({
  '@apps': `${__dirname}/apps`,
  '@core': `${__dirname}/core`,
  '@config': `${__dirname}/config`,
  '@telegram': `${__dirname}/telegram`,
  '@prisma-support': `${__dirname}/../prisma/generated/prisma-support`,
  '@prisma-exchange': `${__dirname}/../../exchange/prisma/generated/prisma-exchange`,
  '@prisma-affiliate': `${__dirname}/../../affiliate/prisma/generated/prisma-affiliate`,
})
