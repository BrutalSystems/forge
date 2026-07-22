const { retryProvision } = require('../../../src/daemon/services/drivers/retry');

const noSleep = () => Promise.resolve();

test('resolves as soon as the attempt returns true', async () => {
  let calls = 0;
  await retryProvision('thing', async () => { calls++; return true; }, { sleep: noSleep });
  expect(calls).toBe(1);
});

test('retries falsy attempts until one succeeds', async () => {
  let calls = 0;
  await retryProvision('thing', async () => ++calls >= 3, { sleep: noSleep });
  expect(calls).toBe(3);
});

test('throws a loud error naming the resource after exhausting attempts', async () => {
  await expect(
    retryProvision('rabbitmq vhost "wmw"', async () => false, { attempts: 4, sleep: noSleep }),
  ).rejects.toThrow(/rabbitmq vhost "wmw".*4 attempts/);
});

test('thrown attempt errors are retried and surfaced in the final message', async () => {
  await expect(
    retryProvision('db', async () => { throw new Error('broker still booting'); }, { attempts: 2, sleep: noSleep }),
  ).rejects.toThrow(/broker still booting/);
});
