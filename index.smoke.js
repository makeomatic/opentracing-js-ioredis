// is used to perform smoke-testing of instrumented redis
/* eslint-disable */
const opentracing = require('opentracing');
const instrumentRedis = require('../../..');

// remap
const RedisConstructor = global.Redis;
const PromiseDesc = Object.getOwnPropertyDescriptor(RedisConstructor, 'Promise');

global.Redis = function Redis(...args) {
  const redis = new RedisConstructor(...args);
  const tracer = opentracing.Tracer();
  instrumentRedis(tracer, redis, {
    traceStatements: true,
  });
  return redis;
};

global.Redis.Cluster = function Cluster(...args) {
  const redis = new RedisConstructor.Cluster(...args);
  const tracer = opentracing.Tracer();
  instrumentRedis(tracer, redis, {
    traceStatements: true,
  });
  return redis;
};

global.Redis.createClient = function createClient(...args) {
  const redis = RedisConstructor.createClient(...args);
  const tracer = opentracing.Tracer();
  instrumentRedis(tracer, redis, {
    traceStatements: true,
  });
  return redis;
};

global.Redis.Command = RedisConstructor.Command;
global.Redis.ReplyError = RedisConstructor.ReplyError;
global.Redis.prototype = RedisConstructor.prototype;
global.Redis.Cluster.prototype = RedisConstructor.Cluster.prototype;

// and now make sure its passed over
Object.defineProperty(global.Redis, 'Promise', PromiseDesc);
