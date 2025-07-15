# Leader Election for Node.js on Kubernetes

A lightweight and zero-dependency leader election utility for Node.js services running in Kubernetes, using [Lease objects](https://kubernetes.io/docs/concepts/architecture/leases/) as the coordination mechanism.

> ⚙️ Written in TypeScript.  
> 🪶 No bundler required.  
> 🔁 Graceful fallback when not running in Kubernetes.

This project is inspired by [Precise-Finance/nestjs-k8s-leader-election](https://github.com/Precise-Finance/nestjs-k8s-leader-election), but is rewritten from scratch due to:

1. The original being tightly coupled with NestJS
2. Several critical bugs in behavior and error handling

---

## ✨ Features

- Uses Kubernetes **Coordination API** (`Lease`) for safe leader election
- Emits **`leaderElected`** and **`leaderLost`** events
- Optionally blocks until leadership is acquired
- Gracefully simulates leadership in non-Kubernetes environments (e.g., local dev)
- Supports auto-renewal and lease loss detection

---

## 📦 Installation

```bash
pnpm add leader-election
# or
npm install leader-election
```

> Requires:
>
> - Node.js ≥ 14
> - Kubernetes ≥ 1.14 (with coordination.k8s.io API group enabled)
> - `@kubernetes/client-node` as a peer dependency

---

## 🚀 Usage

```ts
import { LeaderElectionService } from "leader-election";

const leaderElectionService = new LeaderElectionService({
  leaseName: options.LeaderElection.leaseName,
  awaitLeadership: false,
});

await leaderElectionService.initialize();

leaderElectionService.on("leaderElected", async () => {
  // do something as leader
});

leaderElectionService.on("leaderLost", () => {
  // clean up leadership tasks
});
```

---

## 🧩 API

### `new LeaderElectionService(options)`

| Option            | Type      | Default                 | Description                                |
| ----------------- | --------- | ----------------------- | ------------------------------------------ |
| `leaseName`       | `string`  | `"cst-leader-election"` | Name of the Kubernetes Lease object        |
| `namespace`       | `string`  | `"default"`             | Kubernetes namespace                       |
| `renewalInterval` | `number`  | `10000` (ms)            | How often to renew the lease               |
| `awaitLeadership` | `boolean` | `false`                 | If true, `initialize()` waits until leader |

---

## 📝 Logger

You can provide a custom logger via the `logger` option. The logger must implement `info`, `debug`, and `error` methods (compatible with the standard console API):

```ts
const myLogger = {
  info: (...args) => console.log("[info]", ...args),
  debug: (...args) => {}, // Disable debug in production if needed
  error: (...args) => console.error("[error]", ...args),
};

const leaderElectionService = new LeaderElectionService({
  leaseName: "my-lease",
  logger: myLogger,
});
```

- If you do not provide a logger, `info` and `debug` logs are suppressed by default, and only `error` logs are sent to `console.error`.
- You can integrate any logging library (such as winston, pino, bunyan, etc.) as long as it matches the required interface.

---

## 💹 Events

Use `.on(eventName, handler)` to listen:

| Event           | Triggered when…                            |
| --------------- | ------------------------------------------ |
| `leaderElected` | This instance becomes the leader           |
| `leaderLost`    | Leadership is lost (expired, revoked, etc) |

---

## 🔐 Graceful Shutdown

The service listens for `SIGINT` / `SIGTERM` and releases the lease before exit.

You can also call this manually:

```ts
await leaderElectionService.gracefulShutdown();
```

---

## 🧪 Local Development

When not running in Kubernetes (i.e. no `KUBERNETES_SERVICE_HOST`), the service simulates leadership:

```log
Not running in Kubernetes environment. Leader election will be simulated.
```

---

## 📄 License

MIT © 2025 Addf

---

## 🌐 Links

- Kubernetes Lease API: [https://kubernetes.io/docs/reference/kubernetes-api/cluster-resources/lease-v1/](https://kubernetes.io/docs/reference/kubernetes-api/cluster-resources/lease-v1/)
- @kubernetes/client-node: [https://github.com/kubernetes-client/javascript](https://github.com/kubernetes-client/javascript)
- Original Inspiration: [https://github.com/Precise-Finance/nestjs-k8s-leader-election](https://github.com/Precise-Finance/nestjs-k8s-leader-election)
