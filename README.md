# not-th.re/api

[![Deployment Documentation](https://img.shields.io/badge/Deployment-Documentation-5c6ac4?style=for-the-badge)](https://github.com/not-three/main#deployment)
[![OpenAPI Documentation](https://img.shields.io/badge/OpenAPI-Documentation-5c6ac4?style=for-the-badge)](https://api.not-th.re)
[![Configuration Documentation](https://img.shields.io/badge/Configuration-Documentation-5c6ac4?style=for-the-badge)](https://docs.not-th.re)

Please visit the [main](https://github.com/not-three/main) repository for more information.

The configuration documentation also has a nightly variant:
[https://docs.not-th.re/nightly](https://docs.not-th.re/nightly)

## Valkey & request optimization

The api optionally integrates with [valkey](https://valkey.io) (or any
redis-compatible server). Set `VALKEY_ENABLED=true` to store the internal
cache in valkey instead of memory — shared between all instances.

Additionally `DATABASE_REQUEST_OPTIMIZATION` can reduce database traffic so
serverless databases (e.g. [neon.tech](https://neon.tech)) can go to sleep
while the instance is idle:

- `none` (default): current behavior.
- `light`: longer cache lifetimes, cleanup schedulers run every 15 minutes
  instead of every minute.
- `hard` (requires valkey): additionally keeps rate limit tracking in valkey
  and buffers new notes in valkey, writing them to the database in batches
  (see `VALKEY_FLUSH_INTERVAL_SECONDS` / `VALKEY_FLUSH_MAX_QUEUE_SIZE`).
  Enable valkey persistence (AOF) so buffered notes survive a valkey restart.

See `docker-compose.valkey.yml` for a complete example.
