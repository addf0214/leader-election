# Leader Election

Leader election for Node.js services using Kubernetes [Lease objects](https://kubernetes.io/docs/concepts/architecture/leases/). Written in TypeScript, with no framework dependency.

## Why this project

Inspired by [Precise-Finance/nestjs-k8s-leader-election](https://github.com/Precise-Finance/nestjs-k8s-leader-election), this project was rewritten to remove the NestJS dependency and address bugs in lease renewal, leadership changes, and error handling. The aim is a small library that can be used directly in any Node.js service.

## Features

- Coordinates instances through the Kubernetes Lease API.
- Emits `leaderElected` and `leaderLost` events to start and stop leader tasks.
- Can wait for leadership before initialization completes.
- Renews leases automatically and detects leadership loss through Watch notifications, renewal failures, and lease expiry.
- Simulates leadership for local development outside Kubernetes.

## Installation

```sh
npm install leader-election
# or
pnpm add leader-election
```

Requires Node.js 20.16.0 or later and Kubernetes 1.14 or later with the coordination API enabled. The package includes `@kubernetes/client-node` 0.22.x.

The service account needs `get`, `create`, `update`, and `watch` permissions on `leases` in the `coordination.k8s.io` API group.

## Usage

```ts
import { LeaderElectionService } from "leader-election";

const election = new LeaderElectionService({
  leaseName: "background-jobs",
});

election.on("leaderElected", () => {
  // Start leader tasks.
});

election.on("leaderLost", () => {
  // Stop leader tasks.
});

await election.initialize();
```

Register listeners before calling `initialize()`. Call it once per instance; subsequent calls reject. Both events receive `{ leaseName }`. As with Node.js EventEmitter, async listeners are not awaited.

The leader renews its lease on a timer and gives up leadership on renewal failure or expiry. Watch notifications detect lease changes sooner, while periodic retries handle expiry and Watch interruptions. Each instance has a unique identity, including when processes share a hostname.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `leaseName` | `"leader-election"` | Lease name. Use the same name for competing instances. |
| `namespace` | `NAMESPACE` or `"default"` | Kubernetes namespace. |
| `renewalInterval` | `10000` | Renewal and retry interval in milliseconds; also the Lease API request timeout. |
| `awaitLeadership` | `false` | Make `initialize()` wait until this instance becomes leader. |
| `logger` | Errors only | Object with `info`, `debug`, and `error` methods. |

`renewalInterval` must be an integer from 1 to 1,073,741,000 milliseconds. The lease duration is twice this interval, rounded up to whole seconds.

By default, only errors are logged through `console.error`. Pass `logger: console` to enable all logs, or supply your own logger.

## Shutdown

The service handles `SIGINT` and `SIGTERM`. You can also shut it down explicitly:

```ts
await election.gracefulShutdown();
```

Shutdown stops timers and Watch, emits `leaderLost` if needed, and attempts to release the lease. A pending `initialize()` waiting for leadership rejects. A stopped instance cannot be restarted.

Your application must stop its leader tasks and close its other resources. Shutdown does not wait for election or renewal requests already in flight.

## Local development

Without `KUBERNETES_SERVICE_HOST`, the service skips Kubernetes and assumes leadership. This is intended for local development; instances do not coordinate in this mode.

## License

[MIT](LICENSE), copyright 2025 Addf.
