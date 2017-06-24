# Opentracing Redis Node.js Instrumentation

Implements opentracing Redis instrumentation for `ioredis` node.js client library

## Install

`yarn add opentracing-js-ioredis`

## Usage

#### applyInstrumentation(tracer: opentracer.Tracer, redis: Redis, [opts = {}])

Applies instrumentation to Redis client instance, adding methods for seamlessly tracking calls to database

```js
const Redis = require('ioredis');
const opentracing = require('opentracing');
const applyInstrumentation = require('opentracing-js-ioredis');

const tracer = opentracing.Tracer();
const redis = new Redis();
const opts = {
  remoteServiceName: 'redis-production', // defaults to redis
  name: 'traced', // default to `traced`, name of the function that will be attached to `redis`
  tags: {
    [opentracing.Tags.COMPONENT]: 'database', // extra tags that will be attached to spans all the time
  },
  // commands that won't create traces during `.traced` call, listed are defaults.
  // You can only add commands, not remove them. Pipeline command itself is traced, but needs to be blacklisted
  // as it is a special case
  restrictedCommands: [
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
  ],
};

// now redis is populated with `.traced` command
applyInstrumentation(tracer, redis, opts);
```

##### redis.traced(context: ?Span, commandName: string, ...args: Array<any>): Promise<any> | Void

Invokes `commandName` and passes `args` to it, creating a span with `commandName` and finishing it automatically
Parent context is passed via `context` arg and can be omitted. Make sure you call `.finish()` whenever it's time to

#### applyInstrumentation.traceStatements(enabled: boolean)

May be useful for debugging purposes, enables setting tag of `opentracing.Tag.DB_STATEMENT` to serialized redis command.
This is a serious performance hit and is disabled by default as we call `command.toWritable` twice in that case
