const opentracing = require('opentracing');
const assert = require('assert');
const defaults = require('lodash.defaults');
const Redis = require('ioredis');
const Script = require('ioredis/lib/script');

// Hold original reference so that we an redefine it later
const originalInitPromise = Redis.Command.prototype.initPromise;
const originalScriptExecute = Script.prototype.execute;

// nulify reference
let currentSpan = null;
let traceStatements = false;

/**
 * Wraps promise with span error and finish handlers
 * @param  {opentracing.Span} span - Opentracing Span instance.
 * @param  {Promise} promise - Promise instance.
 * @returns {Promise} - Wrapped Promise.
 */
const wrapPromise = (span, promise) => (
  promise.tapCatch((err) => {
    span.setTag(opentracing.Tags.ERROR, true);
    span.log({ event: 'error', 'error.object': err, message: err.message, stack: err.stack });
  })
  .finally(() => {
    span.finish();
  })
);

/**
 * Restricted commands, we don't patch into them.
 * @type {Array}
 */
const restrictedCommands = Object.create(null, [
  'ping',
  'flushall',
  'flushdb',
  'select',
  'auth',
  'info',
  'quit',
  'slaveof',
  'config',
  'sentinel',
  'cluster',
  'swapdb',
  'monitor',
  'pipeline',
].reduce((map, command) => {
  map[command] = { value: true };
  return map;
}, {}));

// monkey-patch method
Redis.Command.prototype.initPromise = function initPromise() {
  if (restrictedCommands[this.name] === true || currentSpan === null) {
    originalInitPromise.call(this);
    return;
  }

  // grab span reference
  const span = currentSpan;
  currentSpan = null;

  // invoke original method making sure .callback is undefined
  // so that promise.nodeify is not invoked
  const callback = this.callback;
  this.callback = undefined;
  originalInitPromise.call(this);
  this.callback = callback;

  // add statement tracing - this is a huge performance hit,
  // so it's off by default
  if (traceStatements === true) {
    span.setTag(opentracing.Tags.DB_STATEMENT, this.toWritable());
  }

  // rewire this.promise reference to instrumented one
  this.promise = wrapPromise(span, this.promise)
    .asCallback(callback);
};

// monkey-patch execute
Script.prototype.execute = function execute(container, args, options, callback) {
  if (currentSpan === null) {
    return originalScriptExecute.call(this, container, args, options, callback);
  }

  // grab reference now so that it's not overwritten by new Command in the original script
  const span = currentSpan;
  currentSpan = null;

  // do original execute
  const result = originalScriptExecute.call(this, container, args, options);

  // must be promise as this can't be called from pipeline
  return wrapPromise(span, result)
    .asCallback(callback);
};

/**
 * Defines `.traced` command on the redis client, which accepts parent span
 * as first argument and passes over every other argument down the chain
 * @param  {Tracer} tracer - Instance of Opentracing-compatible tracer.
 * @param  {Object} [opts] - Generic configuration options for span.
 * @returns {Void}
 */
module.exports = function applyInstrumentation(tracer, redis, _opts) {
  const opts = _opts || {};

  assert.ok(opts, '`opts` must be defined');
  assert.equal(typeof opts, 'object', '`opts` must be object');

  // configuration options
  defaults(opts, {
    remoteServiceName: 'redis',
    name: 'traced',
    tags: {},
    restrictedCommands: [],
  });

  // ensure that we do not call this multiple times
  assert.equal(typeof redis[opts.name], 'undefined', `${opts.name} is already defined`);

  // append restricted commands
  if (Array.isArray(opts.restrictedCommands)) {
    opts.restrictedCommands.forEach((command) => {
      restrictedCommands[command] = true;
    });
  }

  // cluster, sentinel or regular
  let dbType;
  if (redis instanceof Redis.Cluster) {
    dbType = 'redis-cluster';
  } else if (redis.options.sentinels) {
    dbType = 'redis-sentinel';
  } else {
    dbType = 'redis';
  }

  // default tags
  defaults(opts.tags, {
    [opentracing.Tags.PEER_SERVICE]: opts.remoteServiceName,
    [opentracing.Tags.DB_TYPE]: dbType,
    [opentracing.Tags.DB_INSTANCE]: redis.options.db,
  });

  // provide .[opts.name = traced] method to invoke commands
  redis[opts.name] = (parentContext, commandName, ...args) => {
    // this is done here, because commandName might be changed (for instance with scripts)
    // it will be evalsha + scriptName - that's not informative
    if (restrictedCommands[commandName] !== true) {
      currentSpan = tracer.startSpan(commandName, {
        childOf: parentContext,
        tags: opts.tags,
      });
    } else if (commandName === 'pipeline') {
      const span = tracer.startSpan(commandName, {
        childOf: parentContext,
        tags: opts.tags,
      });

      // init pipeline
      const pipeline = redis[commandName](...args);

      // rewire initialized promise on that pipeline
      pipeline.promise = wrapPromise(span, pipeline.promise);

      return pipeline;
    }

    return redis[commandName](...args);
  };
};

/**
 * Enables/disables statement tracing.
 * @param  {boolean} setting - Set to true/false to disable statement tracing.
 * @returns {Void}
 */
module.exports.traceStatements = function toggleTrace(setting) {
  traceStatements = !!setting;
};
