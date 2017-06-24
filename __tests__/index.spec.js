/* eslint-disable promise/always-return */
const Redis = require('ioredis');
const MockTracer = require('opentracing/lib/mock_tracer').MockTracer;
const assert = require('assert');
const instrumentRedis = require('../');

describe('instrumentRedis', () => {
  const connectOpts = {
    host: 'localhost',
    port: 6379,
  };

  const clusterOpts = [{ host: 'localhost', port: 7000 }];

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

    it('restricted operation', () => (
      redis.traced(null, 'ping').then((response) => {
        assert.equal(response, 'PONG');
        assert.deepEqual(tracer.report().spans, []);
      })
    ));

    it('allowed operation', () => (
      redis.traced(null, 'set', 'xxx', 10).then((response) => {
        assert.equal(response, 'OK');

        const report = tracer.report();
        assert.equal(report.spans.length, 1);
        assert.equal(report.unfinishedSpans.length, 0);
        assert.equal(printReport(report), [
          'Spans:',
          `    set - ${report.spans[0].durationMs()}ms`,
        ].join('\n'));
      })
    ));

    it('parentContext operations', () => {
      const context = tracer.startSpan('parent');
      return redis
        .traced(context, 'set', 'xxx', 'choo')
        .then(() => {
          context.finish();

          const report = tracer.report();
          assert.equal(report.spans.length, 2);
          assert.equal(report.unfinishedSpans.length, 0);
          assert.equal(printReport(report), [
            'Spans:',
            `    parent - ${report.spans[0].durationMs()}ms`,
            `    set - ${report.spans[1].durationMs()}ms`,
          ].join('\n'));
        });
    });

    it('pipeline & parent', () => {
      const context = tracer.startSpan('parent');
      const pipeline = redis.traced(context, 'pipeline');

      pipeline.set('bonjurno', 'yes!');
      pipeline.get('bonjurno');
      pipeline.ping();

      return pipeline.exec().spread((set, get, ping) => {
        assert.ifError(set[0]);
        assert.ifError(get[0]);
        assert.ifError(ping[0]);

        assert.equal(set[1], 'OK');
        assert.equal(get[1], 'yes!');
        assert.equal(ping[1], 'PONG');

        const report = tracer.report();
        assert.equal(report.spans.length, 2);
        assert.equal(report.unfinishedSpans.length, 1);

        assert.equal(printReport(report), [
          'Spans:',
          `    parent - ${report.spans[0].durationMs()}ms`, // <--- unfinished, still printed
          `    pipeline - ${report.spans[1].durationMs()}ms`,
        ].join('\n'));
      });
    });
  });

  describe('instrument Redis.Cluster', () => {
    let redis;
    let tracer;

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
            node.disconnect();
            called += 1;
            if (called === 3) done();
          });
        });
      });
    });
  });
});
