/* eslint-disable import/no-unresolved */
const assert = require('assert');

let Redis;
let Script;

try {
  Redis = require('ioredis');
  Script = require('ioredis/built/script').default || require('ioredis/built/script');
} catch (e) {
  Redis = require('@makeomatic/ioredis');
  Script = require('@makeomatic/ioredis/built/script');
}

assert(Redis, 'ioredis or @makeomatic/ioredis must be available');
assert(Script, 'built/script must be present');

exports.Redis = Redis;
exports.Script = Script;
