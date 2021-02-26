#! /usr/bin/env node

'use strict'

const assert = require('assert')
const split = require('split2')
const PinoColada = require('pino-colada')
const pump = require('pump')
const isDocker = require('is-docker')
const closeWithGrace = require('close-with-grace')
const listenAddressDocker = '0.0.0.0'
const watch = require('./lib/watch')
const parseArgs = require('./args')
const {
  exit,
  requirePath,
  requireFastifyForModule,
  requireServerPluginFromPath,
  showHelpForCommand
} = require('./util')

let Fastify = null

function loadModules (opts) {
  try {
    const { module: fastifyModule } = requireFastifyForModule(opts._[0])

    Fastify = fastifyModule
  } catch (e) {
    module.exports.stop(e)
  }
}

async function start (args) {
  const opts = parseArgs(args)
  if (opts.help) {
    return showHelpForCommand('start')
  }

  if (opts._.length !== 1) {
    console.error('Missing the required file parameter\n')
    return showHelpForCommand('start')
  }

  // we start crashing on unhandledRejection
  require('make-promises-safe')

  loadModules(opts)

  if (opts.watch) {
    return watch(args, opts.ignoreWatch)
  }

  return runFastify(args)
}

function stop (message) {
  exit(message)
}

async function runFastify (args) {
  require('dotenv').config()
  const opts = parseArgs(args)
  if (opts.require) {
    if (typeof opts.require === 'string') {
      opts.require = [opts.require]
    }

    try {
      opts.require.forEach(module => {
        if (module) {
          /* This check ensures we ignore `-r ""`, trailing `-r`, or
           * other silly things the user might (inadvertently) be doing.
           */
          requirePath(module)
        }
      })
    } catch (e) {
      module.exports.stop(e)
    }
  }
  opts.port = opts.port || process.env.PORT || 3000

  loadModules(opts)

  let file = null

  try {
    file = await requireServerPluginFromPath(opts._[0])
  } catch (e) {
    return module.exports.stop(e)
  }

  let logger
  if (opts.loggingModule) {
    try {
      logger = requirePath(opts.loggingModule)
    } catch (e) {
      module.exports.stop(e)
    }
  }

  const defaultLogger = {
    level: opts.logLevel
  }
  const options = {
    logger: logger || defaultLogger,

    pluginTimeout: opts.pluginTimeout
  }

  if (opts.bodyLimit) {
    options.bodyLimit = opts.bodyLimit
  }

  if (opts.prettyLogs) {
    const stream = split(PinoColada())
    options.logger.stream = stream
    pump(stream, process.stdout, assert.ifError)
  }

  if (opts.debug) {
    if (process.version.match(/v[0-6]\..*/g)) {
      stop('Fastify debug mode not compatible with Node.js version < 6')
    } else {
      require('inspector').open(
        opts.debugPort,
        opts.debugHost || isDocker() ? listenAddressDocker : undefined
      )
    }
  }

  const fastify = Fastify(
    opts.options ? Object.assign(options, file.options) : options
  )

  if (opts.prefix) {
    opts.pluginOptions.prefix = opts.prefix
  }

  await fastify.register(file.default || file, opts.pluginOptions)

  const closeListeners = closeWithGrace({ delay: 500 }, async function ({ signal, err, manual }) {
    if (err) {
      fastify.log.error(err)
    }
    await fastify.close()
  })

  await fastify.addHook('onClose', (instance, done) => {
    closeListeners.uninstall()
    done()
  })

  if (opts.address) {
    await fastify.listen(opts.port, opts.address)
  } else if (opts.socket) {
    await fastify.listen(opts.socket)
  } else if (isDocker()) {
    await fastify.listen(opts.port, listenAddressDocker)
  } else {
    await fastify.listen(opts.port)
  }

  return fastify
}

function cli (args) {
  start(args)
}

module.exports = { start, stop, runFastify, cli }

if (require.main === module) {
  cli(process.argv.slice(2))
}
