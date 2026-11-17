const assert = require('node:assert/strict');
const { test } = require('node:test');
const { LeaderElectionService } = require('../lib');

function setup(t, leader = true, options = {}) {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
    const signals = ['SIGINT', 'SIGTERM'];
    const listeners = signals.map(signal => process.listeners(signal));
    const host = process.env.KUBERNETES_SERVICE_HOST;
    delete process.env.KUBERNETES_SERVICE_HOST;
    let service;
    try {
        service = new LeaderElectionService({
            renewalInterval: 1000,
            logger: { info() {}, debug() {}, error() {} },
            ...options,
        });
    } finally {
        if (host !== undefined) process.env.KUBERNETES_SERVICE_HOST = host;
    }
    t.after(() => {
        t.mock.timers.reset();
        signals.forEach((signal, index) => {
            for (const listener of process.listeners(signal)) {
                if (!listeners[index].includes(listener)) process.removeListener(signal, listener);
            }
        });
    });
    const lease = { metadata: { name: 'leader-election' }, spec: { holderIdentity: service.LEADER_IDENTITY, renewTime: new Date(), leaseDurationSeconds: service.durationInSeconds } };
    let writes = 0;
    service.kubeClient = {
        async readNamespacedLease() { return { body: lease }; },
        async replaceNamespacedLease() { writes++; return { body: lease }; },
    };
    if (leader) service.becomeLeader(lease);
    return { service, lease, get writes() { return writes; } };
}

async function tick(t, milliseconds) {
    t.mock.timers.tick(milliseconds);
    // Drain the asynchronous API calls inside the timer callback.
    await new Promise(setImmediate);
}

test('successful renewal repeats without Watch events', async t => {
    const fixture = setup(t);
    for (let i = 1; i <= 3; i++) {
        await tick(t, 1000);
        assert.equal(fixture.writes, i);
    }
});

test('our Watch updates do not postpone scheduled renewal', async t => {
    const fixture = setup(t);
    for (let i = 0; i < 4; i++) {
        await tick(t, 200);
        fixture.service.handleLeaseUpdate(fixture.lease);
    }
    assert.equal(fixture.writes, 0);
    await tick(t, 200);
    assert.equal(fixture.writes, 1);
});

test('the next renewal waits for the current request to finish', async t => {
    const { service, lease } = setup(t, true, { renewalInterval: 10000 });
    let finish;
    let calls = 0;
    service.kubeClient.replaceNamespacedLease = async () => {
        calls++;
        if (calls === 1) await new Promise(resolve => { finish = resolve; });
        return { body: lease };
    };
    await tick(t, 10000);
    assert.equal(calls, 1);
    await tick(t, 5000);
    assert.equal(calls, 1);
    finish();
    await new Promise(setImmediate);
    await tick(t, 9999);
    assert.equal(calls, 1);
    await tick(t, 1);
    assert.equal(calls, 2);
});

test('a failed renewal loses leadership and schedules no further renewal', async t => {
    const { service } = setup(t);
    let lost = 0;
    let calls = 0;
    service.on('leaderLost', () => lost++);
    service.kubeClient.replaceNamespacedLease = async () => {
        calls++;
        throw new Error('API unavailable');
    };
    await tick(t, 1000);
    assert.equal(lost, 1);
    assert.equal(service.leaseRenewalTimeout, null);
    // Follower retries are a separate existing timer.
    assert.ok(service.notLeaderRetryTimeout);
    await tick(t, 999);
    assert.equal(calls, 1);
});

async function watchEvents(service) {
    let notify;
    service.watch = { async watch(path, options, callback) { notify = callback; } };
    await service.watchLeaseObject();
    return notify;
}

test('Watch ownership changes revoke leadership immediately', async t => {
    const { service, lease } = setup(t);
    const notify = await watchEvents(service);
    let lost = 0;
    service.on('leaderLost', () => lost++);
    notify('MODIFIED', { ...lease, spec: { ...lease.spec, holderIdentity: 'other-pod' } });
    assert.equal(lost, 1);
    assert.equal(service.isLeader, false);
});

test('a stale self Watch event cannot promote when the API reports another holder', async t => {
    const { service, lease } = setup(t, false);
    let elected = 0;
    service.on('leaderElected', () => elected++);
    service.kubeClient.readNamespacedLease = async () => ({
        body: { ...lease, spec: { ...lease.spec, holderIdentity: 'other-pod', leaseDurationSeconds: 20 } },
    });
    service.handleLeaseUpdate(lease);
    await tick(t, 4000);
    assert.equal(elected, 0);
});

test('Watch release triggers acquisition without the two-second delay', async t => {
    const fixture = setup(t, false);
    fixture.lease.spec.holderIdentity = undefined;
    const notify = await watchEvents(fixture.service);
    notify('MODIFIED', fixture.lease);
    await tick(t, 0);
    assert.equal(fixture.writes, 1);
    assert.equal(fixture.service.isLeader, true);
});

test('repeated self Watch events share one election and require a successful write', async t => {
    const { service, lease } = setup(t, false);
    let finish;
    let writes = 0;
    let elected = 0;
    service.on('leaderElected', () => elected++);
    service.kubeClient.replaceNamespacedLease = async () => {
        writes++;
        await new Promise(resolve => { finish = resolve; });
        return { body: lease };
    };
    service.handleLeaseUpdate(lease);
    service.handleLeaseUpdate(lease);
    await tick(t, 0);
    assert.equal(writes, 1);
    assert.equal(elected, 0);
    finish();
    await tick(t, 0);
    assert.equal(elected, 1);
});

test('ownership changes during an acquisition invalidate its late response', async t => {
    const { service, lease } = setup(t, false);
    lease.spec.holderIdentity = undefined;
    let finish;
    let elected = 0;
    service.on('leaderElected', () => elected++);
    service.kubeClient.replaceNamespacedLease = async () => {
        await new Promise(resolve => { finish = resolve; });
        return { body: lease };
    };
    service.handleLeaseUpdate(lease);
    await tick(t, 0);
    service.handleLeaseUpdate({ ...lease, spec: { ...lease.spec, holderIdentity: 'other-pod' } });
    finish();
    await tick(t, 0);
    assert.equal(elected, 0);
});

test('shutdown stops renewal and Watch, emits loss, and releases the lease once', async t => {
    const fixture = setup(t);
    const { service, lease } = fixture;
    let notify;
    let watches = 0;
    let aborts = 0;
    let lost = 0;
    service.on('leaderLost', () => lost++);
    service.watch = { async watch(path, options, callback, done) {
        watches++;
        notify = callback;
        return { abort() { aborts++; done(null); } };
    } };
    await service.watchLeaseObject();
    await service.gracefulShutdown();
    assert.equal(lost, 1);
    assert.equal(aborts, 1);
    assert.equal(lease.spec.holderIdentity, undefined);
    assert.equal(process.listeners('SIGINT').includes(service.onSignal), false);
    assert.equal(process.listeners('SIGTERM').includes(service.onSignal), false);
    notify('MODIFIED', lease);
    notify('DELETED', lease);
    await service.gracefulShutdown();
    await tick(t, 10000);
    assert.equal(watches, 1);
    assert.equal(fixture.writes, 1);
    assert.equal(lost, 1);
    assert.equal(service.isLeader, false);
});

test('shutdown cancels follower retries and an already scheduled Watch reconnect', async t => {
    const { service, lease } = setup(t, false);
    lease.spec.holderIdentity = 'another-pod';
    let reads = 0;
    let watches = 0;
    service.kubeClient.readNamespacedLease = async () => { reads++; return { body: lease }; };
    service.watch = { async watch() { watches++; throw new Error('offline'); } };
    service.scheduleNotLeaderRetry();
    await service.watchLeaseObject();
    await service.gracefulShutdown();
    await tick(t, 10000);
    assert.equal(reads, 0);
    assert.equal(watches, 1);
    assert.equal(service.notLeaderRetryTimeout, null);
    assert.equal(service.watchRetryTimeout, null);
});

test('shutdown does not create a missing Lease while releasing', async t => {
    const { service } = setup(t);
    let creates = 0;
    service.kubeClient.readNamespacedLease = async () => {
        throw Object.assign(new Error('Not found'), { response: { statusCode: 404 } });
    };
    service.kubeClient.createNamespacedLease = async () => { creates++; };
    await service.gracefulShutdown();
    assert.equal(creates, 0);
});

test('local shutdown prevents deferred leadership and restarting the service', async t => {
    const { service } = setup(t, false);
    service.kubeClient = null;
    let elected = 0;
    service.on('leaderElected', () => elected++);
    const host = process.env.KUBERNETES_SERVICE_HOST;
    delete process.env.KUBERNETES_SERVICE_HOST;
    try {
        const initialization = service.initialize();
        await service.gracefulShutdown();
        await initialization;
        await tick(t, 0);
        assert.equal(elected, 0);
        await assert.rejects(service.initialize(), /stopped/);
    } finally {
        if (host !== undefined) process.env.KUBERNETES_SERVICE_HOST = host;
    }
});

function initializeInCluster(service, watch = { async watch() { return { abort() {} }; } }) {
    service.watch = watch;
    const host = process.env.KUBERNETES_SERVICE_HOST;
    process.env.KUBERNETES_SERVICE_HOST = 'test';
    try {
        return service.initialize();
    } finally {
        if (host === undefined) delete process.env.KUBERNETES_SERVICE_HOST;
        else process.env.KUBERNETES_SERVICE_HOST = host;
    }
}

test('awaitLeadership remains pending until a later successful election', async t => {
    const { service, lease } = setup(t, false, { awaitLeadership: true });
    lease.spec.holderIdentity = 'other-pod';
    let finished = false;
    const initialization = initializeInCluster(service).then(() => { finished = true; });
    await tick(t, 0);
    assert.equal(finished, false);
    lease.spec.holderIdentity = undefined;
    await tick(t, 1000);
    await initialization;
    assert.equal(service.isLeader, true);
    assert.equal(service.eventEmitter.listenerCount('leaderElected'), 0);
    assert.equal(service.eventEmitter.listenerCount('shutdown'), 0);
});

test('without awaitLeadership initialization returns while another pod is leader', async t => {
    const { service, lease } = setup(t, false);
    lease.spec.holderIdentity = 'other-pod';
    await initializeInCluster(service);
    assert.equal(service.isLeader, false);
});

test('shutdown rejects a pending leadership wait and removes its listeners', async t => {
    const { service, lease } = setup(t, false, { awaitLeadership: true });
    lease.spec.holderIdentity = 'other-pod';
    const initialization = initializeInCluster(service);
    const rejected = assert.rejects(initialization, /stopped before leadership/);
    await tick(t, 0);
    await service.gracefulShutdown();
    await rejected;
    assert.equal(service.eventEmitter.listenerCount('leaderElected'), 0);
    assert.equal(service.eventEmitter.listenerCount('shutdown'), 0);
});

test('awaitLeadership also waits for local simulated leadership', async t => {
    const { service } = setup(t, false, { awaitLeadership: true });
    service.kubeClient = null;
    const host = process.env.KUBERNETES_SERVICE_HOST;
    delete process.env.KUBERNETES_SERVICE_HOST;
    try {
        await service.initialize();
        assert.equal(service.isLeader, true);
    } finally {
        if (host !== undefined) process.env.KUBERNETES_SERVICE_HOST = host;
    }
});

for (const blockedRequest of ['read', 'write']) {
    test('expiry revokes leadership during a blocked renewal ' + blockedRequest, async t => {
        const { service, lease } = setup(t);
        let finish;
        let lost = 0;
        let elected = 0;
        service.on('leaderLost', () => lost++);
        service.on('leaderElected', () => elected++);
        const method = blockedRequest === 'read' ? 'readNamespacedLease' : 'replaceNamespacedLease';
        service.kubeClient[method] = () => new Promise(resolve => { finish = resolve; });
        await tick(t, 1000);
        assert.equal(typeof finish, 'function');
        await tick(t, 999);
        assert.equal(service.isLeader, true);
        await tick(t, 1);
        assert.equal(service.isLeader, false);
        assert.equal(lost, 1);
        assert.equal(service.leaseExpiryTimeout, null);
        finish({ body: lease });
        await tick(t, 0);
        assert.equal(service.isLeader, false);
        assert.equal(elected, 0);
        assert.equal(service.leaseExpiryTimeout, null);
        await service.gracefulShutdown();
    });
}

test('renewal refreshes expiry from its write timestamp rather than response arrival', async t => {
    const { service, lease } = setup(t);
    let finish;
    service.kubeClient.replaceNamespacedLease = () => new Promise(resolve => { finish = resolve; });
    await tick(t, 1000);
    const response = JSON.parse(JSON.stringify(lease));
    await tick(t, 500);
    finish({ body: response });
    await tick(t, 0);
    await tick(t, 1499);
    assert.equal(service.isLeader, true);
    await tick(t, 1);
    assert.equal(service.isLeader, false);
    finish({ body: lease });
    await tick(t, 0);
    await service.gracefulShutdown();
});

test('an acquisition response already expired cannot elect a leader', async t => {
    const { service, lease } = setup(t, false);
    let finish;
    service.kubeClient.replaceNamespacedLease = () => new Promise(resolve => { finish = resolve; });
    const election = service.tryToBecomeLeader();
    await tick(t, 0);
    await tick(t, 2000);
    finish({ body: lease });
    await election;
    assert.equal(service.isLeader, false);
    assert.equal(service.leaseExpiryTimeout, null);
});

test('shutdown clears the expiry timer', async t => {
    const { service } = setup(t);
    assert.ok(service.leaseExpiryTimeout);
    await service.gracefulShutdown();
    assert.equal(service.leaseExpiryTimeout, null);
});

test('two instances with the same hostname remain distinct election contenders', async t => {
    const { service, lease } = setup(t, false);
    const host = process.env.KUBERNETES_SERVICE_HOST;
    delete process.env.KUBERNETES_SERVICE_HOST;
    let second;
    try {
        second = new LeaderElectionService({ logger: { info() {}, debug() {}, error() {} } });
    } finally {
        if (host !== undefined) process.env.KUBERNETES_SERVICE_HOST = host;
    }
    t.after(() => second.gracefulShutdown());
    assert.notEqual(service.LEADER_IDENTITY, second.LEADER_IDENTITY);
    second.kubeClient = service.kubeClient;
    await service.tryToBecomeLeader();
    await second.tryToBecomeLeader();
    assert.equal(service.isLeader, true);
    assert.equal(second.isLeader, false);
    assert.equal(lease.spec.holderIdentity, service.LEADER_IDENTITY);
});

test('lease durations round up fractional seconds', t => {
    const { service } = setup(t, false, { renewalInterval: 750 });
    assert.equal(service.durationInSeconds, 2);
});

test('invalid renewal intervals fail before signal listeners are registered', () => {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const listeners = process.listenerCount('SIGTERM');
    delete process.env.KUBERNETES_SERVICE_HOST;
    try {
        for (const renewalInterval of [0, -1, 0.5, NaN, Infinity, 2147483647]) {
            assert.throws(() => new LeaderElectionService({ renewalInterval }), RangeError);
        }
    } finally {
        if (host !== undefined) process.env.KUBERNETES_SERVICE_HOST = host;
    }
    assert.equal(process.listenerCount('SIGTERM'), listeners);
});

test('SDK lease requests time out and subsequent requests can succeed', { timeout: 5000 }, async t => {
    const http = require('node:http');
    const { KubeConfig } = require('@kubernetes/client-node');
    let respond = false;
    let requests = 0;
    const server = http.createServer((request, response) => {
        requests++;
        if (!respond) return;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ metadata: { name: 'leader-election' }, spec: {} }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
    });
    t.mock.method(KubeConfig.prototype, 'loadFromDefault', function () {
        this.loadFromOptions({
            clusters: [{ name: 'test', server: 'http://127.0.0.1:' + server.address().port }],
            users: [{ name: 'test' }],
            contexts: [{ name: 'test', cluster: 'test', user: 'test' }],
            currentContext: 'test',
        });
    });
    const host = process.env.KUBERNETES_SERVICE_HOST;
    process.env.KUBERNETES_SERVICE_HOST = 'test';
    let service;
    try {
        service = new LeaderElectionService({ renewalInterval: 100 });
    } finally {
        if (host === undefined) delete process.env.KUBERNETES_SERVICE_HOST;
        else process.env.KUBERNETES_SERVICE_HOST = host;
    }
    t.after(() => service.gracefulShutdown());
    await assert.rejects(service.kubeClient.readNamespacedLease('leader-election', 'default'), error =>
        error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT');
    respond = true;
    const { body } = await service.kubeClient.readNamespacedLease('leader-election', 'default');
    assert.equal(body.metadata.name, 'leader-election');
    assert.equal(requests, 2);
});

test('an old renewal callback does not postpone the new leadership renewal', async t => {
    const { service, lease } = setup(t);
    let finish;
    let writes = 0;
    service.kubeClient.replaceNamespacedLease = async () => {
        const body = JSON.parse(JSON.stringify(lease));
        if (++writes === 1) await new Promise(resolve => { finish = resolve; });
        return { body };
    };
    await tick(t, 1000);
    await tick(t, 100);
    service.handleLeaseDeletion();
    await tick(t, 0);
    assert.equal(service.isLeader, true);
    assert.equal(writes, 2);
    await tick(t, 800);
    finish();
    await tick(t, 0);
    await tick(t, 200);
    assert.equal(writes, 3); // Renew at 2100 ms, not 2900 ms after the old response.
});

for (const awaitLeadership of [false, true]) {
    test('repeated initialization opens no additional Watch (awaitLeadership=' + awaitLeadership + ')', async t => {
        const { service, lease } = setup(t, false, { awaitLeadership });
        lease.spec.holderIdentity = 'another-pod';
        let watches = 0;
        let aborts = 0;
        const watch = { async watch() {
            watches++;
            return { abort() { aborts++; } };
        } };
        const initialization = initializeInCluster(service, watch);
        const completion = awaitLeadership
            ? assert.rejects(initialization, /stopped before leadership/)
            : initialization;
        await assert.rejects(initializeInCluster(service, watch), /already been initialized/);
        await tick(t, 0);
        assert.equal(watches, 1);
        await service.gracefulShutdown();
        await completion;
        assert.equal(aborts, 1);
    });
}
