/* eslint-disable promise/always-return */
const Promise = require('bluebird');
const Redis = require('ioredis');
const { MockTracer } = require('opentracing/lib/mock_tracer');
const assert = require('assert');
const instrumentRedis = require('../');

describe('instrumentRedis', () => {
  Redis.Promise = require('bluebird');

  const connectOpts = {
    host: 'localhost',
    port: 6379,
  };

  const clusterOpts = [{ host: '127.0.0.1', port: 7000 }];

  /* eslint-disable no-restricted-syntax */
  const printReport = (report) => {
    const reportData = ['Spans:'];
    for (const span of report.spans) {
      const tags = span.tags();
      const tagKeys = Object.keys(tags);

      reportData.push(`    ${span.operationName()} - ${span.durationMs()}ms`);
      for (const key of tagKeys) {
        const value = tags[key];
        reportData.push(`        tag '${key}':'${value}'`);
      }
    }
    return reportData.join('\n');
  };

  describe('instrument Redis', () => {
    let redis;
    let tracer;

    async function getReport() {
      // NOTE: this is async only due to results being returned before they
      // are recorded by opentracing
      return tracer.report();
    }

    beforeEach(() => {
      redis = new Redis(connectOpts);
      tracer = new MockTracer();
      instrumentRedis(tracer, redis);
    });

    afterEach((done) => {
      tracer.clear();
      redis.flushall(() => {
        redis.script('flush', () => {
          redis.disconnect();
          done();
        });
      });
    });

    it('restricted operation', async () => {
      const response = await redis.traced(null, 'ping');

      assert.equal(response, 'PONG');
      assert.deepEqual((await getReport()).spans, []);
    });

    it('allowed operation', async () => {
      const response = await redis.traced(null, 'set', 'xxx', 10);

      assert.equal(response, 'OK');

      const report = await getReport();

      assert.ifError(report.firstSpanWithTagValue('error', true));

      assert.equal(report.spans.length, 1);
      assert.equal(report.unfinishedSpans.length, 0);
      assert.equal(printReport(report), [
        'Spans:',
        `    set - ${report.spans[0].durationMs()}ms`,
      ].join('\n'));
    });

    it('parentContext operations', async () => {
      const context = tracer.startSpan('parent');
      await redis.traced(context, 'set', 'xxx', 'choo');

      context.finish();

      const report = await getReport();

      assert.ifError(report.firstSpanWithTagValue('error', true));

      assert.equal(report.spans.length, 2);
      assert.equal(report.unfinishedSpans.length, 0);
      assert.equal(printReport(report), [
        'Spans:',
        `    parent - ${report.spans[0].durationMs()}ms`,
        `    set - ${report.spans[1].durationMs()}ms`,
      ].join('\n'));
    });

    it('pipeline & parent', async () => {
      const context = tracer.startSpan('parent');
      const pipeline = redis.traced(context, 'pipeline');

      pipeline.set('bonjurno', 'yes!');
      pipeline.get('bonjurno');
      pipeline.ping();

      const [set, get, ping] = await pipeline.exec();

      assert.ifError(set[0]);
      assert.ifError(get[0]);
      assert.ifError(ping[0]);

      assert.equal(set[1], 'OK');
      assert.equal(get[1], 'yes!');
      assert.equal(ping[1], 'PONG');

      const report = await getReport();
      assert.equal(report.spans.length, 2);
      assert.equal(report.unfinishedSpans.length, 1);

      assert.ifError(report.firstSpanWithTagValue('error', true));

      assert.equal(printReport(report), [
        'Spans:',
        `    parent - ${report.spans[0].durationMs()}ms`, // <--- unfinished, still printed
        `    pipeline - ${report.spans[1].durationMs()}ms`,
      ].join('\n'));
    });

    it('scripts', async () => {
      redis.defineCommand('tracing', {
        numberOfKeys: 2,
        lua: 'return {KEYS[1],KEYS[2],ARGV[1],ARGV[2]}',
      });

      redis.defineCommand('tracingDynamic', {
        lua: 'return KEYS',
      });

      const context = tracer.startSpan('parent');

      const [tracing, tracingDynamic] = await Promise.all([
        redis.traced(context, 'tracing', 'katun', 'baloon', 'indigo'),
        redis.traced(context, 'tracingDynamic', 3, 'one', 'two', 'three'),
      ]);

      context.finish();

      const report = await getReport();

      assert.deepEqual(tracing, ['katun', 'baloon', 'indigo']);
      assert.deepEqual(tracingDynamic, ['one', 'two', 'three']);

      assert.ifError(report.firstSpanWithTagValue('error', true));

      assert.equal(report.spans.length, 3);
      assert.equal(report.unfinishedSpans.length, 0);
      assert.equal(printReport(report), [
        'Spans:',
        `    parent - ${report.spans[0].durationMs()}ms`,
        `    tracing - ${report.spans[1].durationMs()}ms`,
        `    tracingDynamic - ${report.spans[2].durationMs()}ms`,
      ].join('\n'));
    });

    it('mixed pipeline, traced commands & scripts', async () => {
      redis.defineCommand('dynamic', { lua: 'return KEYS' });

      const context = tracer.startSpan('parent');
      const pipeline = redis.traced(context, 'pipeline');
      const normalScript = redis.dynamic(1, 'woo');
      const traced = redis.traced(context, 'dynamic', 3, 1, 2, 3);

      pipeline.ping();
      pipeline.dynamic(4, 1, 2, 3, 4);

      const [pipe, script, trace] = await Promise.all([
        pipeline.exec(),
        normalScript,
        traced,
      ]);

      context.finish();

      assert.deepEqual([
        [null, 'PONG'],
        [null, ['1', '2', '3', '4']],
      ], pipe);

      assert.deepEqual(['1', '2', '3'], trace);
      assert.deepEqual(['woo'], script);

      const report = await getReport();

      assert.equal(report.spans.length, 3);
      assert.equal(report.unfinishedSpans.length, 0);

      assert.ifError(report.firstSpanWithTagValue('error', true));

      assert.equal(printReport(report), [
        'Spans:',
        `    parent - ${report.spans[0].durationMs()}ms`,
        `    pipeline - ${report.spans[1].durationMs()}ms`,
        `    dynamic - ${report.spans[2].durationMs()}ms`,
      ].join('\n'));
    });
  });

  describe('instrument Redis.Cluster', () => {
    let redis;
    let tracer;

    async function getReport() {
      return tracer.report();
    }

    beforeEach(() => {
      redis = new Redis.Cluster(clusterOpts);
      tracer = new MockTracer();
      instrumentRedis(tracer, redis);
    });

    afterEach((done) => {
      let called = 0;
      tracer.clear();
      redis.nodes('master').forEach((node) => {
        node.flushall(() => {
          node.script('flush', () => {
            called += 1;
            if (called === 3) {
              redis.quit(() => {
                done();
              });
            }
          });
        });
      });
    });

    it('restricted operation', async () => {
      const response = await redis.traced(null, 'ping');

      assert.equal(response, 'PONG');
      assert.deepEqual((await getReport()).spans, []);
    });

    it('allowed operation', async () => {
      const response = await redis.traced(null, 'set', 'xxx', 10);
      assert.equal(response, 'OK');

      const report = await getReport();

      assert.ifError(report.firstSpanWithTagValue('error', true));

      assert.equal(report.spans.length, 1);
      assert.equal(report.unfinishedSpans.length, 0);
      assert.equal(printReport(report), [
        'Spans:',
        `    set - ${report.spans[0].durationMs()}ms`,
      ].join('\n'));
    });

    it('parentContext operations', async () => {
      const context = tracer.startSpan('parent');
      await redis.traced(context, 'set', 'xxx', 'choo');

      context.finish();

      const report = await getReport();

      assert.ifError(report.firstSpanWithTagValue('error', true));

      assert.equal(report.spans.length, 2);
      assert.equal(report.unfinishedSpans.length, 0);
      assert.equal(printReport(report), [
        'Spans:',
        `    parent - ${report.spans[0].durationMs()}ms`,
        `    set - ${report.spans[1].durationMs()}ms`,
      ].join('\n'));
    });

    it('pipeline & parent', async () => {
      const context = tracer.startSpan('parent');
      const pipeline = redis.traced(context, 'pipeline');

      pipeline.set('bonjurno', 'yes!');
      pipeline.get('bonjurno');
      pipeline.ping();

      const [set, get, ping] = await pipeline.exec();

      assert.ifError(set[0]);
      assert.ifError(get[0]);
      assert.ifError(ping[0]);

      assert.equal(set[1], 'OK');
      assert.equal(get[1], 'yes!');
      assert.equal(ping[1], 'PONG');

      const report = await getReport();
      assert.equal(report.spans.length, 2);
      assert.equal(report.unfinishedSpans.length, 1);

      assert.ifError(report.firstSpanWithTagValue('error', true));

      assert.equal(printReport(report), [
        'Spans:',
        `    parent - ${report.spans[0].durationMs()}ms`, // <--- unfinished, still printed
        `    pipeline - ${report.spans[1].durationMs()}ms`,
      ].join('\n'));
    });

    it('scripts', async () => {
      redis.defineCommand('tracing', {
        numberOfKeys: 2,
        lua: 'return {KEYS[1],KEYS[2],ARGV[1],ARGV[2]}',
      });

      redis.defineCommand('tracingDynamic', {
        lua: 'return KEYS',
      });

      const context = tracer.startSpan('parent');

      const [tracing, tracingDynamic] = await Promise.all([
        redis.traced(context, 'tracing', '{1}katun', '{1}baloon', '{1}indigo'),
        redis.traced(context, 'tracingDynamic', 3, '{1}one', '{1}two', '{1}three'),
      ]);

      context.finish();
      const report = await getReport();

      assert.deepEqual(tracing, ['{1}katun', '{1}baloon', '{1}indigo']);
      assert.deepEqual(tracingDynamic, ['{1}one', '{1}two', '{1}three']);

      assert.ifError(report.firstSpanWithTagValue('error', true));

      assert.equal(report.spans.length, 3);
      assert.equal(report.unfinishedSpans.length, 0);
      assert.equal(printReport(report), [
        'Spans:',
        `    parent - ${report.spans[0].durationMs()}ms`,
        `    tracing - ${report.spans[1].durationMs()}ms`,
        `    tracingDynamic - ${report.spans[2].durationMs()}ms`,
      ].join('\n'));
    });

    it('mixed pipeline, traced commands & scripts', async () => {
      redis.defineCommand('dynamic', { lua: 'return KEYS' });

      const context = tracer.startSpan('parent');
      const pipeline = redis.traced(context, 'pipeline');
      const normalScript = redis.traced(context, 'dynamic', 1, 'woo');
      const traced = redis.traced(context, 'dynamic', 3, 1, 2, 3);

      pipeline.ping();
      pipeline.dynamic(4, 1, 2, 3, 4);

      const [pipe, script, trace] = await Promise.all([
        pipeline.exec().reflect(),
        normalScript,
        traced.reflect(),
      ]);

      context.finish();

      assert.equal(pipe.reason().message, 'Sending custom commands in pipeline is not supported in Cluster mode.');

      assert.deepEqual('CROSSSLOT Keys in request don\'t hash to the same slot', trace.reason().message);
      assert.deepEqual(['woo'], script);

      const report = await getReport();

      assert.equal(report.spans.length, 4);
      assert.equal(report.unfinishedSpans.length, 0);

      assert.ok(report.firstSpanWithTagValue('error', true));

      assert.equal(printReport(report), [
        'Spans:',
        `    parent - ${report.spans[0].durationMs()}ms`,
        `    pipeline - ${report.spans[1].durationMs()}ms`,
        "        tag 'error':'true'",
        `    dynamic - ${report.spans[2].durationMs()}ms`,
        `    dynamic - ${report.spans[3].durationMs()}ms`,
        "        tag 'error':'true'",
      ].join('\n'));
    });
  });
});
